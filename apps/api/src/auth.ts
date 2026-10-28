import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface User {
  id: string
  displayName: string
}

/** `user` adds the second person to the household; `device` adds a passkey for the inviter. */
export type InviteKind = 'user' | 'device'

export interface Invite {
  codeHash: string
  kind: InviteKind
  userId: string | null
}

export interface StoredPasskey {
  id: string
  userId: string
  publicKey: Uint8Array
  counter: number
  transports: string[] | undefined
}

/** One household, two people. */
export const MAX_USERS = 2
export const INVITE_TTL_MS = 10 * 60_000
export const SETUP_INVITE_TTL_MS = 60 * 60_000
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000

/** No 0/O or 1/I, so a code read off one screen and typed into another survives. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const iso = (ms: number) => new Date(ms).toISOString()

export function userCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  return row.n
}

export function getUser(db: DatabaseSync, id: string): User | null {
  const row = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(id) as
    { id: string; display_name: string } | undefined
  return row ? { id: row.id, displayName: row.display_name } : null
}

/** Uppercases and drops separators; null when it cannot be a code at all. */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== CODE_LENGTH) return null
  for (const char of code) if (!CODE_ALPHABET.includes(char)) return null
  return code
}

function generateCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

export function createInvite(
  db: DatabaseSync,
  opts: { kind: InviteKind; createdBy: string | null; now: number; ttlMs?: number },
): { code: string; expiresAt: string } {
  if (opts.kind === 'user' && userCount(db) >= MAX_USERS) {
    throw new AuthError(409, 'The household already has two people')
  }
  if (opts.kind === 'device' && !opts.createdBy) {
    throw new AuthError(400, 'A device code belongs to a signed-in person')
  }
  // Spent and lapsed codes are of no use to anyone; sweep them as new ones are made.
  db.prepare('DELETE FROM invites WHERE used_at IS NOT NULL OR expires_at <= ?').run(iso(opts.now))
  const code = generateCode()
  const expiresAt = iso(opts.now + (opts.ttlMs ?? INVITE_TTL_MS))
  db.prepare(
    `INSERT INTO invites (code_hash, kind, user_id, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    sha256(code),
    opts.kind,
    opts.kind === 'device' ? opts.createdBy : null,
    opts.createdBy,
    iso(opts.now),
    expiresAt,
  )
  return { code: formatCode(code), expiresAt }
}

/**
 * With no users yet nobody can sign in to make an invite, so the server makes one and logs it.
 * Returns null once someone has registered.
 */
export function ensureSetupInvite(db: DatabaseSync, now: number): string | null {
  if (userCount(db) > 0) return null
  db.prepare('DELETE FROM invites WHERE created_by IS NULL AND used_at IS NULL').run()
  return createInvite(db, { kind: 'user', createdBy: null, now, ttlMs: SETUP_INVITE_TTL_MS }).code
}

export function findInvite(db: DatabaseSync, codeHash: string, now: number): Invite | null {
  const row = db
    .prepare(
      `SELECT code_hash, kind, user_id FROM invites
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .get(codeHash, iso(now)) as
    { code_hash: string; kind: InviteKind; user_id: string | null } | undefined
  return row ? { codeHash: row.code_hash, kind: row.kind, userId: row.user_id } : null
}

export function findInviteByCode(db: DatabaseSync, input: string, now: number): Invite | null {
  const code = normalizeCode(input)
  return code ? findInvite(db, sha256(code), now) : null
}

/**
 * Spends the invite and stores the new passkey (and the new user, for a `user` invite) as one
 * step, so a code can never be used twice, even by two requests at once.
 */
export function completeRegistration(
  db: DatabaseSync,
  opts: {
    invite: Invite
    userId: string
    displayName: string
    passkey: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] }
    now: number
  },
): User {
  const { invite, passkey } = opts
  db.exec('BEGIN IMMEDIATE')
  try {
    const spent = db
      .prepare('UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
      .run(iso(opts.now), invite.codeHash)
    if (spent.changes !== 1) throw new AuthError(403, 'That code has already been used')
    let user: User
    if (invite.kind === 'user') {
      if (userCount(db) >= MAX_USERS) {
        throw new AuthError(409, 'The household already has two people')
      }
      user = { id: opts.userId, displayName: opts.displayName }
      db.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run(
        user.id,
        user.displayName,
        iso(opts.now),
      )
    } else {
      const existing = invite.userId ? getUser(db, invite.userId) : null
      if (!existing) throw new AuthError(403, 'That code is no longer valid')
      user = existing
    }
    db.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      passkey.id,
      user.id,
      passkey.publicKey,
      passkey.counter,
      passkey.transports ? JSON.stringify(passkey.transports) : null,
      iso(opts.now),
    )
    db.exec('COMMIT')
    return user
  } catch (error) {
    db.exec('ROLLBACK')
    // A credential ID is unique: registering an authenticator twice is a client mistake.
    if (error instanceof Error && /UNIQUE constraint failed: passkeys\.id/.test(error.message)) {
      throw new AuthError(409, 'That passkey is already registered')
    }
    throw error
  }
}

export function passkeysForUser(db: DatabaseSync, userId: string): StoredPasskey[] {
  const rows = db.prepare('SELECT * FROM passkeys WHERE user_id = ?').all(userId)
  return rows.map(toPasskey)
}

export function getPasskey(db: DatabaseSync, id: string): StoredPasskey | null {
  const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(id)
  return row ? toPasskey(row) : null
}

function toPasskey(row: Record<string, unknown>): StoredPasskey {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    publicKey: row.public_key as Uint8Array,
    counter: row.counter as number,
    transports: row.transports ? (JSON.parse(row.transports as string) as string[]) : undefined,
  }
}

export function recordPasskeyUse(db: DatabaseSync, id: string, counter: number, now: number) {
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(
    counter,
    iso(now),
    id,
  )
}

/** Returns the bearer token; only its hash is stored, so a leaked database holds no sessions. */
export function createSession(db: DatabaseSync, userId: string, now: number): string {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(iso(now))
  const token = randomBytes(32).toString('base64url')
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(sha256(token), userId, iso(now), iso(now + SESSION_TTL_MS))
  return token
}

export function userForSession(db: DatabaseSync, token: string, now: number): User | null {
  const row = db
    .prepare(
      `SELECT u.id, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), iso(now)) as { id: string; display_name: string } | undefined
  return row ? { id: row.id, displayName: row.display_name } : null
}

export function deleteSession(db: DatabaseSync, token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
}

export const newUserId = () => randomUUID()

/** Short-lived, single-use server state for the two-step WebAuthn ceremonies. */
export class CeremonyStore<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>()

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maxEntries = 200,
  ) {}

  put(value: T, now: number): string {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id)
    if (this.entries.size >= this.maxEntries) {
      // Drop the oldest rather than refuse: a flood of abandoned ceremonies must not lock people out.
      this.entries.delete(this.entries.keys().next().value!)
    }
    const id = randomBytes(24).toString('base64url')
    this.entries.set(id, { value, expiresAt: now + this.ttlMs })
    return id
  }

  /** Removes and returns the entry: a challenge can be answered once. */
  take(id: string, now: number): T | undefined {
    const entry = this.entries.get(id)
    this.entries.delete(id)
    return entry && entry.expiresAt > now ? entry.value : undefined
  }
}

/** Counts bad pairing codes so the code space cannot be walked; shared by everyone, which is fine for two people. */
export class FailureLimiter {
  private failures: number[] = []

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
  ) {}

  assertOpen(now: number) {
    this.failures = this.failures.filter((at) => at > now - this.windowMs)
    if (this.failures.length >= this.max) {
      throw new AuthError(429, 'Too many wrong codes; wait a few minutes and try again')
    }
  }

  fail(now: number) {
    this.failures.push(now)
  }
}
