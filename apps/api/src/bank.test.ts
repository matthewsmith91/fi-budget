import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { createSession } from './auth.ts'
import { KEY_FILE, loadBankKey, open, seal } from './bank.ts'
import { openDatabase } from './db.ts'
import { claimSetupToken, parseAccountSet, parseCents, type Fetch } from './simplefin.ts'

const ORIGIN = 'https://budget.example.com'
const NOW = Date.parse('2026-10-28T12:00:00Z')
const CLAIM_URL = 'https://bridge.simplefin.test/simplefin/claim/abc123'
const ACCESS_URL = 'https://user%40x:p%3Aw@bridge.simplefin.test/simplefin'
const setupToken = (url = CLAIM_URL) => Buffer.from(url).toString('base64')

const ACCOUNT_SET = {
  errors: ['Bank of Nowhere needs you to sign in again'],
  accounts: [
    {
      org: { domain: 'bank.test', name: 'Credit Union', id: 'bank.test' },
      id: 'ACT-1',
      name: 'Checking',
      currency: 'USD',
      balance: '1234.56',
      'available-balance': '1200.00',
      'balance-date': 1792000000,
      transactions: [
        { id: 'T1', posted: 1791900000, amount: '-12.345', description: 'COFFEE' },
        { id: 'T2', posted: 1791900000, amount: '2500.00', description: 'PAYROLL' },
        { id: 'T3', posted: 0, amount: '-5.00', description: 'HOLD', pending: true },
      ],
    },
  ],
}

interface Call {
  url: string
  method: string
  authorization?: string
}

/** A SimpleFIN stand-in that records what it was asked and answers from `respond`. */
function fakeSimplefin(respond: (url: URL) => Response) {
  const calls: Call[] = []
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
    })
    return respond(url)
  }
  return { calls, fetchImpl }
}

describe('parseCents', () => {
  it('reads decimal strings without floats', () => {
    expect(parseCents('12.34')).toBe(1234)
    expect(parseCents('-0.07')).toBe(-7)
    expect(parseCents('5')).toBe(500)
    expect(parseCents('19.99')).toBe(1999)
    expect(parseCents(0.1)).toBe(10)
  })

  it('rounds half away from zero', () => {
    expect(parseCents('1.005')).toBe(101)
    expect(parseCents('-1.005')).toBe(-101)
    expect(parseCents('1.004')).toBe(100)
  })

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['', 'abc', '1e5', '1,000.00', null, undefined]) {
      expect(() => parseCents(bad)).toThrow()
    }
  })
})

describe('parseAccountSet', () => {
  it('normalizes accounts to cents and drops pending transactions', () => {
    const { accounts, messages } = parseAccountSet(ACCOUNT_SET)
    expect(messages).toEqual(['Bank of Nowhere needs you to sign in again'])
    expect(accounts).toEqual([
      {
        id: 'ACT-1',
        name: 'Checking',
        org: 'Credit Union',
        currency: 'USD',
        balance: 123456,
        availableBalance: 120000,
        balanceDate: '2026-10-14T17:46:40.000Z',
        transactions: [
          { id: 'T1', posted: '2026-10-13', amount: -1235, description: 'COFFEE' },
          { id: 'T2', posted: '2026-10-13', amount: 250000, description: 'PAYROLL' },
        ],
      },
    ])
  })

  it('reads messages from errlist too', () => {
    const { messages } = parseAccountSet({
      errlist: [{ code: 'gen.auth', msg: 'Sign in' }],
      accounts: [],
    })
    expect(messages).toEqual(['Sign in'])
  })

  it('refuses a response it cannot read', () => {
    expect(() => parseAccountSet({})).toThrow(/accounts is missing/)
    expect(() => parseAccountSet({ accounts: [{ id: 'a', name: 'n', balance: 'x' }] })).toThrow(
      /could not read/,
    )
  })
})

describe('claimSetupToken', () => {
  it('posts to the claim URL and returns the access URL', async () => {
    const { calls, fetchImpl } = fakeSimplefin(() => new Response(`${ACCESS_URL}\n`))
    expect(await claimSetupToken(setupToken(), fetchImpl)).toBe(ACCESS_URL)
    expect(calls).toMatchObject([{ url: CLAIM_URL, method: 'POST' }])
  })

  it('refuses claim URLs that are not public https hosts, without fetching them', async () => {
    const { calls, fetchImpl } = fakeSimplefin(() => new Response(ACCESS_URL))
    for (const url of [
      'http://bridge.simplefin.test/claim/x',
      'https://localhost/claim/x',
      'https://127.0.0.1/claim/x',
      'https://[::1]/claim/x',
    ]) {
      await expect(claimSetupToken(setupToken(url), fetchImpl)).rejects.toMatchObject({
        status: 400,
      })
    }
    await expect(claimSetupToken('not base64 of a url', fetchImpl)).rejects.toMatchObject({
      status: 400,
    })
    expect(calls).toEqual([])
  })

  it('says so when the token was already used', async () => {
    const { fetchImpl } = fakeSimplefin(() => new Response('', { status: 403 }))
    await expect(claimSetupToken(setupToken(), fetchImpl)).rejects.toThrow(/already have been used/)
  })

  it('refuses an access URL that points somewhere private', async () => {
    const { fetchImpl } = fakeSimplefin(() => new Response('https://u:p@10.0.0.5/simplefin'))
    await expect(claimSetupToken(setupToken(), fetchImpl)).rejects.toMatchObject({ status: 502 })
  })
})

describe('sealing', () => {
  it('round-trips and does not reveal the plaintext', () => {
    const key = randomBytes(32)
    const sealed = seal(ACCESS_URL, key)
    expect(sealed.startsWith('v1:')).toBe(true)
    expect(sealed).not.toContain('simplefin')
    expect(open(sealed, key)).toBe(ACCESS_URL)
    expect(seal(ACCESS_URL, key)).not.toBe(sealed)
  })

  it('fails to open with another key or after tampering', () => {
    const sealed = seal('secret', randomBytes(32))
    expect(() => open(sealed, randomBytes(32))).toThrow()
    const key = randomBytes(32)
    const good = seal('secret', key)
    const raw = Buffer.from(good.slice(3), 'base64')
    raw[raw.length - 1]! ^= 1
    expect(() => open(`v1:${raw.toString('base64')}`, key)).toThrow()
  })
})

describe('loadBankKey', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bank-key-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('makes a private key file once and reuses it', () => {
    const first = loadBankKey(dir, {})
    expect(first).toHaveLength(32)
    expect(statSync(join(dir, KEY_FILE)).mode & 0o777).toBe(0o600)
    expect(loadBankKey(dir, {}).equals(first)).toBe(true)
  })

  it('prefers BANK_KEY and rejects one of the wrong size', () => {
    const key = randomBytes(32)
    expect(loadBankKey(dir, { BANK_KEY: key.toString('base64') }).equals(key)).toBe(true)
    expect(() => loadBankKey(dir, { BANK_KEY: 'AAAA' })).toThrow(/32 bytes/)
    expect(() => readFileSync(join(dir, KEY_FILE))).toThrow()
  })
})

describe('/api/bank', () => {
  let db: DatabaseSync
  let server: Server
  let base: string
  let cookie: string
  let key: Buffer
  let sf: ReturnType<typeof fakeSimplefin>
  let respondAccounts: (url: URL) => Response

  beforeEach(async () => {
    db = openDatabase(':memory:')
    key = randomBytes(32)
    respondAccounts = () => Response.json(ACCOUNT_SET)
    sf = fakeSimplefin((url) =>
      url.pathname.includes('/claim/') ? new Response(ACCESS_URL) : respondAccounts(url),
    )
    server = createApp({
      db,
      staticDir: '/nonexistent',
      auth: { rpId: 'budget.example.com', origins: [ORIGIN], now: () => NOW },
      bank: { key, fetch: sf.fetchImpl },
    }).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (typeof address !== 'object' || !address) throw new Error('no address')
    base = `http://127.0.0.1:${address.port}`
    db.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run(
      'u1',
      'Matt',
      new Date(NOW).toISOString(),
    )
    cookie = `bf_session=${createSession(db, 'u1', NOW)}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    db.close()
  })

  const call = (method: string, path: string, body?: unknown, headers = { cookie }) =>
    fetch(`${base}/api/bank${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  const link = async () =>
    (await (await call('POST', '/links', { setupToken: setupToken() })).json()).id

  it('requires a signed-in person', async () => {
    expect((await call('GET', '/links', undefined, {} as never)).status).toBe(401)
    expect((await call('POST', '/links', { setupToken: setupToken() }, {} as never)).status).toBe(
      401,
    )
    expect((await call('POST', '/fetch', {}, {} as never)).status).toBe(401)
    expect(sf.calls).toEqual([])
  })

  it('links a bank, keeping the access URL sealed and out of every response', async () => {
    const res = await call('POST', '/links', { setupToken: setupToken() })
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(created).toMatchObject({
      provider: 'simplefin',
      createdBy: 'u1',
      createdAt: new Date(NOW).toISOString(),
      lastFetchedAt: null,
    })
    expect(JSON.stringify(created)).not.toContain('simplefin/')

    const stored = db.prepare('SELECT access_token FROM bank_links').get() as {
      access_token: string
    }
    expect(stored.access_token).not.toContain('bridge.simplefin.test')
    expect(open(stored.access_token, key)).toBe(ACCESS_URL)

    const listed = await (await call('GET', '/links')).json()
    expect(listed).toEqual({ links: [created] })
  })

  it('needs a setup token and stores nothing for one that is not a URL', async () => {
    expect((await call('POST', '/links', {})).status).toBe(400)
    expect((await call('POST', '/links', { setupToken: 'bm90IGEgdXJs' })).status).toBe(400)
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_links').get()).toEqual({ n: 0 })
    expect(sf.calls).toEqual([])
  })

  it('fetches with Basic auth taken from the access URL and a 30-day default window', async () => {
    const id = await link()
    const res = await call('POST', '/fetch', {})
    expect(res.status).toBe(200)
    const { results } = await res.json()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ linkId: id, ok: true })
    expect(results[0].accounts[0].transactions).toHaveLength(2)
    expect(results[0].messages).toEqual(['Bank of Nowhere needs you to sign in again'])

    const fetched = sf.calls[1]!
    const url = new URL(fetched.url)
    expect(url.username).toBe('')
    expect(url.pathname).toBe('/simplefin/accounts')
    expect(fetched.authorization).toBe(`Basic ${Buffer.from('user@x:p:w').toString('base64')}`)
    const end = Number(url.searchParams.get('end-date'))
    expect(end).toBe(NOW / 1000)
    expect(end - Number(url.searchParams.get('start-date'))).toBe(30 * 86400)

    const [{ last_fetched_at }] = db.prepare('SELECT last_fetched_at FROM bank_links').all() as {
      last_fetched_at: string
    }[]
    expect(last_fetched_at).toBe(new Date(NOW).toISOString())
  })

  it('passes a date window through, including the end day, and balances-only', async () => {
    await link()
    await call('POST', '/fetch', { startDate: '2026-10-01', endDate: '2026-10-10' })
    const window = new URL(sf.calls[1]!.url).searchParams
    expect(window.get('start-date')).toBe(String(Date.parse('2026-10-01T00:00:00Z') / 1000))
    expect(window.get('end-date')).toBe(String(Date.parse('2026-10-11T00:00:00Z') / 1000))

    await call('POST', '/fetch', { balancesOnly: true })
    const balances = new URL(sf.calls[2]!.url).searchParams
    expect(balances.get('balances-only')).toBe('1')
    expect(balances.has('start-date')).toBe(false)
  })

  it('refuses a bad or oversized window before contacting the bank', async () => {
    await link()
    const before = sf.calls.length
    for (const body of [
      { startDate: 'yesterday' },
      { startDate: '2026-02-30', endDate: '2026-03-01' },
      { startDate: '2026-10-10', endDate: '2026-10-01' },
      { startDate: '2026-01-01', endDate: '2026-10-01' },
    ]) {
      expect((await call('POST', '/fetch', body)).status).toBe(400)
    }
    expect(sf.calls).toHaveLength(before)
  })

  it('reports one failing link beside the working one', async () => {
    await link()
    await link()
    let n = 0
    respondAccounts = () =>
      n++ === 0 ? Response.json(ACCOUNT_SET) : new Response('', { status: 429 })
    const { results } = await (await call('POST', '/fetch', {})).json()
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ ok: true })
    expect(results[1]).toMatchObject({ ok: false })
    expect(results[1].error).toMatch(/rate limit/)
    const stamped = db.prepare('SELECT id FROM bank_links WHERE last_fetched_at IS NOT NULL').all()
    expect(stamped).toHaveLength(1)
  })

  it('fetches one link when asked and 404s for an unknown one', async () => {
    const first = await link()
    await link()
    const { results } = await (await call('POST', '/fetch', { linkId: first })).json()
    expect(results.map((r: { linkId: string }) => r.linkId)).toEqual([first])
    expect((await call('POST', '/fetch', { linkId: 'nope' })).status).toBe(404)
  })

  it('does not leak the access URL when SimpleFIN fails', async () => {
    await link()
    respondAccounts = () => new Response('<html>oops</html>')
    const text = await (await call('POST', '/fetch', {})).text()
    expect(text).toContain('unreadable')
    expect(text).not.toContain('p%3Aw')
  })

  it('unlinks a bank', async () => {
    const id = await link()
    expect((await call('DELETE', `/links/${id}`)).status).toBe(204)
    expect((await call('DELETE', `/links/${id}`)).status).toBe(404)
    expect((await (await call('GET', '/links')).json()).links).toEqual([])
  })

  it('refuses a cross-origin write', async () => {
    const res = await call('POST', '/links', { setupToken: setupToken() }, {
      cookie,
      origin: 'https://evil.example',
    } as never)
    expect(res.status).toBe(403)
    expect(sf.calls).toEqual([])
  })
})
