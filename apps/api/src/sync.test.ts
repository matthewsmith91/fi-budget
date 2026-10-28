import type { Server } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { createSession } from './auth.ts'
import { openDatabase } from './db.ts'
import { emptyTrie, insertTimestamp } from './merkle.ts'
import { BATCH_LIMIT, type ChangeMessage } from './sync.ts'

const ORIGIN = 'https://budget.example.com'
const NOW = Date.parse('2026-10-28T12:00:00Z')
const A = '0123456789abcdef'
const B = 'fedcba9876543210'

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

function msg(n: number, over: Partial<ChangeMessage> = {}, device = A): ChangeMessage {
  const second = String(n % 60).padStart(2, '0')
  const minute = String(Math.floor(n / 60) % 60).padStart(2, '0')
  return {
    timestamp: `2026-10-28T10:${minute}:${second}.000Z-0000-${device}`,
    table: 'accounts',
    rowId: `row-${n}`,
    column: 'name',
    value: `Account ${n}`,
    deviceId: device,
    ...over,
  }
}

const post = (body: unknown, headers: Record<string, string> = { cookie }) =>
  fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  })

const get = (path: string, headers: Record<string, string> = { cookie }) =>
  fetch(`${base}/api/sync${path}`, { headers })

describe('sync endpoints', () => {
  it('require a signed-in person', async () => {
    expect((await post({ cursor: 0, messages: [] }, {})).status).toBe(401)
    expect((await get('/trie', {})).status).toBe(401)
    expect((await get('/messages?from=2026-01-01T00:00:00.000Z', {})).status).toBe(401)
  })

  it('stores pushed messages and hands them to another device after its cursor', async () => {
    const first = await (await post({ cursor: 0, messages: [msg(1), msg(2)] })).json()
    expect(first.messages.map((m: ChangeMessage) => m.rowId)).toEqual(['row-1', 'row-2'])
    expect(first).toMatchObject({ cursor: 2, hasMore: false })

    const other = await (await post({ cursor: 0, messages: [msg(3, {}, B)] })).json()
    expect(other.messages).toHaveLength(3)
    const caughtUp = await (await post({ cursor: first.cursor, messages: [] })).json()
    expect(caughtUp.messages.map((m: ChangeMessage) => m.rowId)).toEqual(['row-3'])
    expect(caughtUp.messages[0]).toEqual(msg(3, {}, B))
  })

  it('stores a message once however often it is pushed', async () => {
    await post({ cursor: 0, messages: [msg(1)] })
    const again = await (await post({ cursor: 0, messages: [msg(1), msg(1)] })).json()
    expect(again.messages).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM server_messages').get()).toEqual({ n: 1 })
  })

  it('keeps value types, including null and numbers', async () => {
    const sent = [
      msg(1, { value: 12345 }),
      msg(2, { value: null }),
      msg(3, { value: '0042' }),
      msg(4, { column: '_deleted', value: 1 }),
    ]
    const res = await (await post({ cursor: 0, messages: sent })).json()
    expect(res.messages).toEqual(sent)
  })

  it('pages a long log and says when there is more', async () => {
    const all = Array.from({ length: BATCH_LIMIT }, (_, i) => msg(i))
    await post({ cursor: 0, messages: all })
    await post({ cursor: 0, messages: [msg(BATCH_LIMIT)] })
    const page = await (await post({ cursor: 0, messages: [] })).json()
    expect(page.messages).toHaveLength(BATCH_LIMIT)
    expect(page.hasMore).toBe(true)
    const rest = await (await post({ cursor: page.cursor, messages: [] })).json()
    expect(rest.messages).toHaveLength(1)
    expect(rest.hasMore).toBe(false)
  })

  it('reports a root hash that matches a trie built from the same timestamps', async () => {
    const sent = [msg(1), msg(2), msg(65, {}, B)]
    const res = await (await post({ cursor: 0, messages: sent })).json()
    const expected = emptyTrie()
    for (const m of sent) insertTimestamp(expected, m.timestamp)
    expect(res.root).toBe(expected.hash)
    expect((await (await get('/trie')).json()).trie).toEqual(expected)
  })

  it('clamps a cursor from beyond the log, as after a restore from an older copy', async () => {
    await post({ cursor: 0, messages: [msg(1)] })
    const res = await (await post({ cursor: 500, messages: [] })).json()
    expect(res).toMatchObject({ messages: [], cursor: 1, hasMore: false })
  })

  it('lists messages stamped at or after a time, in pages by arrival', async () => {
    await post({ cursor: 0, messages: [msg(1), msg(70), msg(130)] })
    const res = await (await get('/messages?from=2026-10-28T10:01:00.000Z&after=0')).json()
    expect(res.messages.map((m: ChangeMessage) => m.rowId)).toEqual(['row-70', 'row-130'])
    expect(res.next).toBeNull()
    const later = await (await get('/messages?from=2026-10-28T10:01:00.000Z&after=2')).json()
    expect(later.messages.map((m: ChangeMessage) => m.rowId)).toEqual(['row-130'])
  })

  describe('refuses', () => {
    it.each([
      ['a malformed timestamp', { timestamp: 'yesterday' }],
      ['a timestamp far in the future', { timestamp: `2027-01-01T00:00:00.000Z-0000-${A}` }],
      ['a device id that is not the timestamp node', { deviceId: B }],
      ['a table name with punctuation', { table: 'accounts; drop' }],
      ['a column name with punctuation', { column: 'name"' }],
      ['an empty row id', { rowId: '' }],
      ['an object value', { value: { a: 1 } as unknown as string }],
      ['a boolean value', { value: true as unknown as string }],
    ])('%s', async (_name, over) => {
      const res = await post({ cursor: 0, messages: [msg(1, over)] })
      expect(res.status).toBe(400)
      expect(db.prepare('SELECT COUNT(*) AS n FROM server_messages').get()).toEqual({ n: 0 })
    })

    it('a batch with one bad message stores none of it', async () => {
      const res = await post({ cursor: 0, messages: [msg(1), msg(2, { rowId: '' })] })
      expect(res.status).toBe(400)
      expect(db.prepare('SELECT COUNT(*) AS n FROM server_messages').get()).toEqual({ n: 0 })
    })

    it('an oversized batch, a missing cursor and a bad range', async () => {
      const tooMany = Array.from({ length: BATCH_LIMIT + 1 }, (_, i) => msg(i))
      expect((await post({ cursor: 0, messages: tooMany })).status).toBe(400)
      expect((await post({ messages: [] })).status).toBe(400)
      expect((await post({ cursor: -1, messages: [] })).status).toBe(400)
      expect((await post({ cursor: 0, messages: 'nope' })).status).toBe(400)
      expect((await get('/messages?from=soon')).status).toBe(400)
      expect((await get('/messages?from=2026-01-01T00:00:00.000Z&after=x')).status).toBe(400)
    })

    it('a push from another origin', async () => {
      const res = await post(
        { cursor: 0, messages: [] },
        { cookie, origin: 'https://evil.example' },
      )
      expect(res.status).toBe(403)
    })
  })

  it('accepts a batch bigger than the general body limit', async () => {
    const big = Array.from({ length: BATCH_LIMIT }, (_, i) => msg(i, { value: 'x'.repeat(200) }))
    expect(JSON.stringify(big).length).toBeGreaterThan(100 * 1024)
    expect((await post({ cursor: 0, messages: big })).status).toBe(200)
  })
})
