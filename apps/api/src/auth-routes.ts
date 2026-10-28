import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { Router, type NextFunction, type Request, type Response } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import {
  AuthError,
  CeremonyStore,
  FailureLimiter,
  MAX_USERS,
  completeRegistration,
  createInvite,
  createSession,
  deleteSession,
  findInvite,
  findInviteByCode,
  getPasskey,
  getUser,
  newUserId,
  passkeysForUser,
  recordPasskeyUse,
  userCount,
  userForSession,
  type User,
} from './auth.ts'

export interface AuthDeps {
  db: DatabaseSync
  rpId: string
  rpName: string
  /** Origins the app is served from. */
  origins: string[]
  /** Injectable clock, in epoch milliseconds. */
  now?: () => number
}

export const SESSION_COOKIE = 'bf_session'
const MAX_NAME_LENGTH = 40

type RegisterCeremony = {
  codeHash: string
  challenge: string
  userId: string
  displayName: string
}

declare module 'express-serve-static-core' {
  interface Locals {
    /** Set by `sessionMiddleware` when the request carries a live session. */
    user?: User
  }
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return undefined
}

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined
}

function stringField(body: unknown, key: string): string {
  const value = field(body, key)
  if (typeof value !== 'string') throw new AuthError(400, `${key} is required`)
  return value
}

function objectField(body: unknown, key: string): Record<string, unknown> {
  const value = field(body, key)
  if (typeof value !== 'object' || value === null) throw new AuthError(400, `${key} is required`)
  return value as Record<string, unknown>
}

/** Resolves the session cookie into `res.locals.user`; never rejects on its own. */
export function sessionMiddleware({ db, now = Date.now }: Pick<AuthDeps, 'db' | 'now'>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE)
    if (token) res.locals.user = userForSession(db, token, now()) ?? undefined
    next()
  }
}

export function requireUser(_req: Request, res: Response, next: NextFunction) {
  if (!res.locals.user) {
    res.status(401).json({ error: 'Sign in first' })
    return
  }
  next()
}

/** A browser always sends Origin on a POST; refuse one from anywhere but the app. */
export function sameOriginOnly(origins: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
    const origin = req.headers.origin
    if (!safe && origin !== undefined && !origins.includes(origin)) {
      res.status(403).json({ error: 'Cross-origin request refused' })
      return
    }
    next()
  }
}

export function createAuthRouter(deps: AuthDeps): Router {
  const { db, rpId, rpName, origins } = deps
  const now = deps.now ?? Date.now
  const secure = origins.every((origin) => origin.startsWith('https:'))
  const registrations = new CeremonyStore<RegisterCeremony>()
  const logins = new CeremonyStore<{ challenge: string }>()
  const limiter = new FailureLimiter()

  const startSession = (res: Response, userId: string) => {
    const token = createSession(db, userId, now())
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/',
      maxAge: 30 * 24 * 60 * 60_000,
    })
  }

  const router = Router()
  router.use(sessionMiddleware(deps))

  router.get('/status', (_req, res) => {
    res.json({ setupRequired: userCount(db) === 0, user: res.locals.user ?? null })
  })

  // Pairing, step 1: trade a one-time code for WebAuthn registration options.
  router.post('/register/options', async (req, res) => {
    limiter.assertOpen(now())
    const invite = findInviteByCode(db, stringField(req.body, 'code'), now())
    if (!invite) {
      limiter.fail(now())
      throw new AuthError(403, 'That code is not valid or has expired')
    }
    let userId: string
    let displayName: string
    let exclude: { id: string; transports?: string[] }[] = []
    if (invite.kind === 'user') {
      displayName = stringField(req.body, 'displayName').trim()
      if (!displayName || displayName.length > MAX_NAME_LENGTH) {
        throw new AuthError(400, `Enter a name of 1 to ${MAX_NAME_LENGTH} characters`)
      }
      if (userCount(db) >= MAX_USERS)
        throw new AuthError(409, 'The household already has two people')
      userId = newUserId()
    } else {
      const user = invite.userId ? getUser(db, invite.userId) : null
      if (!user) throw new AuthError(403, 'That code is no longer valid')
      userId = user.id
      displayName = user.displayName
      exclude = passkeysForUser(db, user.id).map((key) => ({
        id: key.id,
        transports: key.transports,
      }))
    }
    const options = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: displayName,
      userDisplayName: displayName,
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      excludeCredentials: exclude,
      // Discoverable, so sign-in needs no username; verified, so the passkey is a real second factor.
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    })
    const ceremonyId = registrations.put(
      { codeHash: invite.codeHash, challenge: options.challenge, userId, displayName },
      now(),
    )
    res.json({ ceremonyId, options })
  })

  // Pairing, step 2: verify the new passkey, spend the code and sign in.
  router.post('/register/verify', async (req, res) => {
    const ceremony = registrations.take(stringField(req.body, 'ceremonyId'), now())
    if (!ceremony) throw new AuthError(400, 'This sign-up expired; start again')
    const invite = findInvite(db, ceremony.codeHash, now())
    if (!invite) throw new AuthError(403, 'That code is not valid or has expired')
    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: objectField(req.body, 'response') as unknown as RegistrationResponseJSON,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: origins,
        expectedRPID: rpId,
        requireUserVerification: true,
      })
    } catch {
      throw new AuthError(400, 'The passkey could not be verified')
    }
    if (!verification.verified) throw new AuthError(400, 'The passkey could not be verified')
    const { credential } = verification.registrationInfo
    const user = completeRegistration(db, {
      invite,
      userId: ceremony.userId,
      displayName: ceremony.displayName,
      passkey: {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports,
      },
      now: now(),
    })
    startSession(res, user.id)
    res.json({ user })
  })

  router.post('/login/options', async (_req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'required',
    })
    res.json({ ceremonyId: logins.put({ challenge: options.challenge }, now()), options })
  })

  router.post('/login/verify', async (req, res) => {
    const ceremony = logins.take(stringField(req.body, 'ceremonyId'), now())
    if (!ceremony) throw new AuthError(400, 'This sign-in expired; start again')
    const response = objectField(req.body, 'response') as unknown as AuthenticationResponseJSON
    const stored = typeof response.id === 'string' ? getPasskey(db, response.id) : null
    // The same answer for "unknown passkey" and "bad signature" tells a prober nothing.
    const refused = new AuthError(401, 'That passkey is not recognised')
    if (!stored) throw refused
    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: origins,
        expectedRPID: rpId,
        credential: {
          id: stored.id,
          publicKey: new Uint8Array(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports,
        },
        requireUserVerification: true,
      })
    } catch {
      throw refused
    }
    if (!verification.verified) throw refused
    recordPasskeyUse(db, stored.id, verification.authenticationInfo.newCounter, now())
    const user = getUser(db, stored.userId)
    if (!user) throw refused
    startSession(res, user.id)
    res.json({ user })
  })

  router.post('/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE)
    if (token) deleteSession(db, token)
    res.clearCookie(SESSION_COOKIE, { path: '/' })
    res.status(204).end()
  })

  // A signed-in person makes a one-time code to pair their own new device, or to add the other person.
  router.post('/invites', requireUser, (req, res) => {
    const kind = field(req.body, 'kind')
    if (kind !== 'device' && kind !== 'user') {
      throw new AuthError(400, 'kind must be "device" or "user"')
    }
    res.status(201).json({
      kind,
      ...createInvite(db, { kind, createdBy: res.locals.user!.id, now: now() }),
    })
  })

  return router
}
