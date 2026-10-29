import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { createSession } from './auth.ts'
import { seal } from './bank.ts'
import { openDatabase } from './db.ts'
import {
  FIRST_PULL_DAYS,
  PULL_EVERY_MS,
  RETRY_AFTER_ERROR_MS,
  dueLinks,
  pullLink,
  runDuePulls,
} from './pull.ts'
import type { Fetch } from './simplefin.ts'

const ORIGIN = 'https://budget.example.com'
const NOW = Date.parse('2026-10-28T12:00:00Z')
const ACCESS_URL = 'https://user:pw@bridge.simplefin.test/simplefin'
const DAY = 86_400_000

const accountSet = (...ids: string[]) => ({
  accounts: [
    {
      org: { name: 'Credit Union' },
      id: 'ACT-1',
      name: 'Checking',
      balance: '10.00',
      'balance-date': 1792000000,
      transactions: ids.map((id, i) => ({
        id,
        posted: 1791900000 + i,
        amount: '-12.34',
        description: `PAYEE ${id}`,
      })),
    },
  ],
})

describe('daily pull', () => {
  let db: DatabaseSync
  let key: Buffer
  let now: number
  let urls: URL[]
  let respond: () => Response
  const fetchImpl: Fetch = async (input) => {
    urls.push(new URL(String(input)))
    return respond()
  }
  const deps = () => ({ db, key, now: () => now, fetch: fetchImpl })

  const addLink = (id = 'L1') => {
    db.prepare(
      'INSERT INTO bank_links (id, provider, access_token, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, 'simplefin', seal(ACCESS_URL, key), new Date(NOW - DAY).toISOString())
    return { id, access_token: seal(ACCESS_URL, key) }
  }
  const waiting = () =>
    db.prepare('SELECT transaction_id FROM import_queue WHERE applied_at IS NULL ORDER BY id').all()

  beforeEach(() => {
    db = openDatabase(':memory:')
    key = randomBytes(32)
    now = NOW
    urls = []
    respond = () => Response.json(accountSet('T1', 'T2'))
  })
  afterEach(() => db.close())

  it('queues what it fetches and reaches back 30 days the first time', async () => {
    const link = addLink()
    const result = await pullLink(deps(), link)
    expect(result).toEqual({ linkId: 'L1', ok: true, queued: 2 })
    expect(waiting()).toHaveLength(2)

    const params = urls[0]!.searchParams
    expect(Number(params.get('end-date'))).toBe(NOW / 1000)
    expect(Number(params.get('start-date'))).toBe(
      Date.parse('2026-10-28T00:00:00Z') / 1000 - (FIRST_PULL_DAYS - 1) * 86400,
    )
    const cursor = db.prepare('SELECT * FROM sync_cursors').get()
    expect(cursor).toMatchObject({ cursor: '2026-10-28', last_error: null })
    expect(db.prepare('SELECT last_fetched_at FROM bank_links').get()).toEqual({
      last_fetched_at: new Date(NOW).toISOString(),
    })
  })

  it('re-reads a few days before the last pull and does not queue a transaction twice', async () => {
    const link = addLink()
    await pullLink(deps(), link)
    now += DAY
    respond = () => Response.json(accountSet('T1', 'T2', 'T3'))
    expect(await pullLink(deps(), link)).toMatchObject({ ok: true, queued: 1 })
    expect(waiting()).toHaveLength(3)
    expect(Number(urls[1]!.searchParams.get('start-date'))).toBe(
      Date.parse('2026-10-28T00:00:00Z') / 1000 - 3 * 86400,
    )
  })

  it('never asks for more than SimpleFIN allows after a long gap', async () => {
    const link = addLink()
    await pullLink(deps(), link)
    now += 200 * DAY
    await pullLink(deps(), link)
    const params = urls[1]!.searchParams
    expect(Number(params.get('end-date')) - Number(params.get('start-date'))).toBeLessThanOrEqual(
      90 * 86400,
    )
  })

  it('records a failure, keeps the old cursor and tries again sooner than a day', async () => {
    const link = addLink()
    await pullLink(deps(), link)
    now += DAY
    respond = () => new Response('', { status: 429 })
    const failed = await pullLink(deps(), link)
    expect(failed).toMatchObject({ ok: false })
    expect(failed.error).toMatch(/rate limit/)
    expect(db.prepare('SELECT cursor, last_error FROM sync_cursors').get()).toMatchObject({
      cursor: '2026-10-28',
    })

    expect(dueLinks(db, now + RETRY_AFTER_ERROR_MS - 1)).toHaveLength(0)
    expect(dueLinks(db, now + RETRY_AFTER_ERROR_MS)).toHaveLength(1)
  })

  it('pulls only links that are due', async () => {
    addLink('L1')
    addLink('L2')
    expect(await runDuePulls(deps())).toHaveLength(2)
    expect(await runDuePulls(deps())).toHaveLength(0)
    now += PULL_EVERY_MS - 1
    expect(await runDuePulls(deps())).toHaveLength(0)
    now += 1
    expect(await runDuePulls(deps())).toHaveLength(2)
  })

  it('drops queue rows older than the retention window', async () => {
    const link = addLink()
    await pullLink(deps(), link)
    now += 101 * DAY
    respond = () => Response.json(accountSet('T3'))
    await runDuePulls(deps())
    expect(db.prepare('SELECT transaction_id FROM import_queue').all()).toEqual([
      { transaction_id: 'T3' },
    ])
  })

  it('removes a link’s queue and cursor with the link', async () => {
    const link = addLink()
    await pullLink(deps(), link)
    db.prepare('DELETE FROM bank_links WHERE id = ?').run(link.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_queue').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_cursors').get()).toEqual({ n: 0 })
  })
})

describe('/api/bank/queue', () => {
  let db: DatabaseSync
  let server: Server
  let base: string
  let cookie: string

  beforeEach(async () => {
    db = openDatabase(':memory:')
    server = createApp({
      db,
      staticDir: '/nonexistent',
      auth: { rpId: 'budget.example.com', origins: [ORIGIN], now: () => NOW },
      bank: { key: randomBytes(32) },
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
    db.prepare(
      'INSERT INTO bank_links (id, provider, access_token, created_at) VALUES (?, ?, ?, ?)',
    ).run('L1', 'simplefin', 'x', new Date(NOW).toISOString())
    const insert = db.prepare(
      `INSERT INTO import_queue (link_id, account_external_id, account_name, account_org,
         transaction_id, posted, amount, description, fetched_at)
       VALUES ('L1', ?, ?, 'Credit Union', ?, '2026-10-27', -500, 'COFFEE', ?)`,
    )
    const at = new Date(NOW).toISOString()
    insert.run('A1', 'Checking', 't1', at)
    insert.run('A2', 'Savings', 't2', at)
    insert.run('A1', 'Checking', 't3', at)
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

  it('requires a signed-in person', async () => {
    expect((await call('GET', '/queue', undefined, {} as never)).status).toBe(401)
    expect((await call('POST', '/queue/applied', { ids: [1] }, {} as never)).status).toBe(401)
  })

  it('groups waiting transactions by bank account, with the ids to hand back', async () => {
    const { accounts } = await (await call('GET', '/queue')).json()
    expect(accounts).toEqual([
      {
        id: 'A1',
        name: 'Checking',
        org: 'Credit Union',
        transactions: [
          { id: 't1', posted: '2026-10-27', amount: -500, description: 'COFFEE' },
          { id: 't3', posted: '2026-10-27', amount: -500, description: 'COFFEE' },
        ],
        queueIds: [1, 3],
      },
      {
        id: 'A2',
        name: 'Savings',
        org: 'Credit Union',
        transactions: [{ id: 't2', posted: '2026-10-27', amount: -500, description: 'COFFEE' }],
        queueIds: [2],
      },
    ])
  })

  it('stops handing out what a device has applied', async () => {
    expect((await call('POST', '/queue/applied', { ids: [1, 3] })).status).toBe(204)
    const { accounts } = await (await call('GET', '/queue')).json()
    expect(accounts.map((a: { id: string }) => a.id)).toEqual(['A2'])
    // applying twice, or an id that does not exist, is harmless
    expect((await call('POST', '/queue/applied', { ids: [1, 99] })).status).toBe(204)
  })

  it('rejects ids that are not whole numbers', async () => {
    for (const ids of ['1', [1.5], ['1'], null]) {
      expect((await call('POST', '/queue/applied', { ids })).status).toBe(400)
    }
  })

  it('shows the pull state and queue size on the link', async () => {
    db.prepare(
      'INSERT INTO sync_cursors (link_id, cursor, last_run, last_error) VALUES (?, ?, ?, ?)',
    ).run('L1', '2026-10-28', '2026-10-28T11:00:00.000Z', 'SimpleFIN rate limit reached')
    const { links } = await (await call('GET', '/links')).json()
    expect(links[0]).toMatchObject({
      queued: 3,
      lastPullAt: '2026-10-28T11:00:00.000Z',
      pullError: 'SimpleFIN rate limit reached',
    })
  })
})
