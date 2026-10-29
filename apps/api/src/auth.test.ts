import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { SESSION_TTL_MS, ensureSetupInvite, userCount } from './auth.ts'
import { openDatabase } from './db.ts'
import { VirtualAuthenticator } from './test-utils.ts'

const ORIGIN = 'https://budget.example.com'
const RP_ID = 'budget.example.com'

let db: DatabaseSync
let server: Server
let base: string
let clock: number

beforeEach(async () => {
  clock = Date.parse('2026-10-28T12:00:00Z')
  db = openDatabase(':memory:')
  server = createApp({
    db,
    staticDir: '/nonexistent',
    auth: { rpId: RP_ID, origins: [ORIGIN], now: () => clock },
    bank: { key: randomBytes(32) },
  }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('no address')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  db.close()
})

/** One browser: keeps its own session cookie. */
class Browser {
  cookie = ''

  async post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
    return this.send('POST', path, body, headers)
  }

  async get(path: string) {
    return this.send('GET', path)
  }

  private async send(method: string, path: string, body?: unknown, headers = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie)
      this.cookie = setCookie.split(';')[0]!.endsWith('=') ? '' : setCookie.split(';')[0]!
    return {
      status: res.status,
      headers: res.headers,
      json: (await res.json().catch(() => null)) as any,
    }
  }

  /** Redeems a code: the whole pairing ceremony with a fresh software passkey. */
  async register(code: string, displayName: string | undefined, key = new VirtualAuthenticator()) {
    const start = await this.post('/api/auth/register/options', { code, displayName })
    if (start.status !== 200) return { start, key }
    const finish = await this.post('/api/auth/register/verify', {
      ceremonyId: start.json.ceremonyId,
      response: key.create(start.json.options, ORIGIN),
    })
    return { start, finish, key }
  }

  async signIn(key: VirtualAuthenticator, origin = ORIGIN) {
    const start = await this.post('/api/auth/login/options')
    return this.post('/api/auth/login/verify', {
      ceremonyId: start.json.ceremonyId,
      response: key.get(start.json.options, origin),
    })
  }
}

/** The first person, signed in on their own browser. */
async function firstPerson(name = 'Matt') {
  const code = ensureSetupInvite(db, clock)!
  const browser = new Browser()
  const { key, finish } = await browser.register(code, name)
  expect(finish?.status).toBe(200)
  return { browser, key, user: finish!.json.user as { id: string; displayName: string } }
}

describe('setup', () => {
  it('asks for setup until the first person registers', async () => {
    const browser = new Browser()
    expect((await browser.get('/api/auth/status')).json).toEqual({
      setupRequired: true,
      user: null,
    })
    await firstPerson()
    expect((await new Browser().get('/api/auth/status')).json).toEqual({
      setupRequired: false,
      user: null,
    })
  })

  it('makes a setup code only while nobody has registered', async () => {
    expect(ensureSetupInvite(db, clock)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    await firstPerson()
    expect(ensureSetupInvite(db, clock)).toBeNull()
  })

  it('registers the first person and signs them in with a locked-down cookie', async () => {
    const code = ensureSetupInvite(db, clock)!
    const browser = new Browser()
    const { finish } = await browser.register(code, '  Matt ')
    expect(finish!.status).toBe(200)
    expect(finish!.json.user.displayName).toBe('Matt')
    const cookie = finish!.headers.get('set-cookie')!
    expect(cookie).toMatch(/^bf_session=/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Strict/i)
    expect(cookie).toMatch(/Secure/i)
    expect((await browser.get('/api/auth/status')).json.user.displayName).toBe('Matt')
  })

  it('accepts a code typed in lower case without the dash', async () => {
    const code = ensureSetupInvite(db, clock)!
    const { finish } = await new Browser().register(code.replace('-', '').toLowerCase(), 'Matt')
    expect(finish!.status).toBe(200)
  })

  it('needs a name for a new person', async () => {
    const code = ensureSetupInvite(db, clock)!
    const { start } = await new Browser().register(code, '  ')
    expect(start.status).toBe(400)
    const long = await new Browser().register(code, 'x'.repeat(41))
    expect(long.start.status).toBe(400)
  })
})

describe('one-time codes', () => {
  it('cannot be used twice', async () => {
    const code = ensureSetupInvite(db, clock)!
    await new Browser().register(code, 'Matt')
    const again = await new Browser().register(code, 'Mallory')
    expect(again.start.status).toBe(403)
    expect(userCount(db)).toBe(1)
  })

  it('cannot be used by two overlapping sign-ups', async () => {
    const code = ensureSetupInvite(db, clock)!
    const a = new Browser()
    const b = new Browser()
    const startA = await a.post('/api/auth/register/options', { code, displayName: 'A' })
    const startB = await b.post('/api/auth/register/options', { code, displayName: 'B' })
    const keyA = new VirtualAuthenticator()
    const keyB = new VirtualAuthenticator()
    const finishA = await a.post('/api/auth/register/verify', {
      ceremonyId: startA.json.ceremonyId,
      response: keyA.create(startA.json.options, ORIGIN),
    })
    const finishB = await b.post('/api/auth/register/verify', {
      ceremonyId: startB.json.ceremonyId,
      response: keyB.create(startB.json.options, ORIGIN),
    })
    expect([finishA.status, finishB.status]).toEqual([200, 403])
    expect(userCount(db)).toBe(1)
  })

  it('expire after ten minutes', async () => {
    const { browser } = await firstPerson()
    const { json } = await browser.post('/api/auth/invites', { kind: 'device' })
    clock += 10 * 60_000 + 1
    const { start } = await new Browser().register(json.code, undefined)
    expect(start.status).toBe(403)
  })

  it('lock out guessing after ten wrong codes', async () => {
    const code = ensureSetupInvite(db, clock)!
    const browser = new Browser()
    for (let i = 0; i < 10; i++) {
      expect((await browser.post('/api/auth/register/options', { code: 'AAAA-AAAA' })).status).toBe(
        403,
      )
    }
    expect((await browser.post('/api/auth/register/options', { code })).status).toBe(429)
    clock += 15 * 60_000 + 1
    expect(
      (await browser.post('/api/auth/register/options', { code, displayName: 'Matt' })).status,
    ).toBe(200)
  })

  it('are stored only as hashes', async () => {
    const code = ensureSetupInvite(db, clock)!
    const rows = db.prepare('SELECT code_hash FROM invites').all() as { code_hash: string }[]
    expect(rows.map((r) => r.code_hash)).not.toContain(code.replace('-', ''))
    expect(rows[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('sign-in', () => {
  it('signs in on a new browser with the registered passkey', async () => {
    const { key, user } = await firstPerson()
    const other = new Browser()
    const res = await other.signIn(key)
    expect(res.status).toBe(200)
    expect(res.json.user).toEqual(user)
    expect((await other.get('/api/auth/status')).json.user).toEqual(user)
  })

  it('refuses a passkey the server has never seen', async () => {
    await firstPerson()
    const res = await new Browser().signIn(new VirtualAuthenticator())
    expect(res.status).toBe(401)
  })

  it('refuses an assertion made for a different origin', async () => {
    const { key } = await firstPerson()
    const res = await new Browser().signIn(key, 'https://evil.example.com')
    expect(res.status).toBe(401)
  })

  it('answers each challenge only once', async () => {
    const { key } = await firstPerson()
    const browser = new Browser()
    const start = await browser.post('/api/auth/login/options')
    const body = {
      ceremonyId: start.json.ceremonyId,
      response: key.get(start.json.options, ORIGIN),
    }
    expect((await browser.post('/api/auth/login/verify', body)).status).toBe(200)
    expect((await new Browser().post('/api/auth/login/verify', body)).status).toBe(400)
  })

  it('refuses a challenge that has expired', async () => {
    const { key } = await firstPerson()
    const browser = new Browser()
    const start = await browser.post('/api/auth/login/options')
    clock += 5 * 60_000 + 1
    const res = await browser.post('/api/auth/login/verify', {
      ceremonyId: start.json.ceremonyId,
      response: key.get(start.json.options, ORIGIN),
    })
    expect(res.status).toBe(400)
  })

  it('refuses an authenticator whose counter did not advance (a cloned key)', async () => {
    const { key } = await firstPerson()
    expect((await new Browser().signIn(key)).status).toBe(200)
    key.rewind()
    expect((await new Browser().signIn(key)).status).toBe(401)
  })

  it('ends the session on sign-out', async () => {
    const { browser } = await firstPerson()
    const token = browser.cookie
    expect((await browser.post('/api/auth/logout')).status).toBe(204)
    expect((await browser.get('/api/auth/status')).json.user).toBeNull()
    // The old cookie is dead server-side, not just forgotten by the browser.
    const replay = new Browser()
    replay.cookie = token
    expect((await replay.get('/api/auth/status')).json.user).toBeNull()
  })

  it('expires sessions after thirty days', async () => {
    const { browser } = await firstPerson()
    clock += SESSION_TTL_MS - 1
    expect((await browser.get('/api/auth/status')).json.user).not.toBeNull()
    clock += 2
    expect((await browser.get('/api/auth/status')).json.user).toBeNull()
  })

  it('stores only a hash of the session token', async () => {
    const { browser } = await firstPerson()
    const token = browser.cookie.split('=')[1]!
    const rows = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token_hash).not.toBe(token)
  })
})

describe('pairing a new device', () => {
  it('gives the same person a second passkey', async () => {
    const { browser, user } = await firstPerson()
    const invite = await browser.post('/api/auth/invites', { kind: 'device' })
    expect(invite.status).toBe(201)
    expect(invite.json.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)

    const phone = new Browser()
    const { start, finish, key } = await phone.register(invite.json.code, undefined)
    // The server reuses the existing identity and tells the new device which keys to skip.
    expect(start.json.options.user.name).toBe('Matt')
    expect(start.json.options.excludeCredentials).toHaveLength(1)
    expect(finish!.json.user).toEqual(user)
    expect(userCount(db)).toBe(1)

    // The phone's own passkey now works from a cold browser.
    const res = await new Browser().signIn(key)
    expect(res.json.user).toEqual(user)
  })

  it('refuses a device code from someone not signed in', async () => {
    await firstPerson()
    const res = await new Browser().post('/api/auth/invites', { kind: 'device' })
    expect(res.status).toBe(401)
  })

  it('rejects an unknown kind of code', async () => {
    const { browser } = await firstPerson()
    expect((await browser.post('/api/auth/invites', { kind: 'admin' })).status).toBe(400)
    expect((await browser.post('/api/auth/invites', {})).status).toBe(400)
  })

  it('refuses a passkey registered for another site', async () => {
    const { browser } = await firstPerson()
    const { json } = await browser.post('/api/auth/invites', { kind: 'device' })
    const phone = new Browser()
    const start = await phone.post('/api/auth/register/options', { code: json.code })
    const res = await phone.post('/api/auth/register/verify', {
      ceremonyId: start.json.ceremonyId,
      response: new VirtualAuthenticator().create(start.json.options, 'https://evil.example.com'),
    })
    expect(res.status).toBe(400)
    // The failed attempt does not burn the code.
    expect((await new Browser().register(json.code, undefined)).finish!.status).toBe(200)
  })
})

describe('the second person', () => {
  it('joins with a user code and has their own identity', async () => {
    const { browser, user: matt } = await firstPerson()
    const invite = await browser.post('/api/auth/invites', { kind: 'user' })
    const phone = new Browser()
    const { finish } = await phone.register(invite.json.code, 'Jessica')
    expect(finish!.status).toBe(200)
    expect(finish!.json.user.displayName).toBe('Jessica')
    expect(finish!.json.user.id).not.toBe(matt.id)
    expect(userCount(db)).toBe(2)
  })

  it('stops at two people', async () => {
    const { browser } = await firstPerson()
    const invite = await browser.post('/api/auth/invites', { kind: 'user' })
    await new Browser().register(invite.json.code, 'Jessica')
    const third = await browser.post('/api/auth/invites', { kind: 'user' })
    expect(third.status).toBe(409)
  })

  it('stops a second user code issued before the household filled up', async () => {
    const { browser } = await firstPerson()
    const a = await browser.post('/api/auth/invites', { kind: 'user' })
    const b = await browser.post('/api/auth/invites', { kind: 'user' })
    expect((await new Browser().register(a.json.code, 'Jessica')).finish!.status).toBe(200)
    const late = await new Browser().register(b.json.code, 'Sam')
    expect(late.start.status).toBe(409)
    expect(userCount(db)).toBe(2)
  })
})

describe('request hygiene', () => {
  it('refuses a cross-origin POST', async () => {
    const res = await new Browser().post(
      '/api/auth/login/options',
      {},
      { origin: 'https://evil.example.com' },
    )
    expect(res.status).toBe(403)
  })

  it('answers a malformed body with a JSON error', async () => {
    const res = await fetch(`${base}/api/auth/register/options`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid request body' })
  })

  it('answers missing fields with a 400, not a crash', async () => {
    const res = await new Browser().post('/api/auth/register/verify', {})
    expect(res.status).toBe(400)
  })
})
