import { beforeEach, describe, expect, it } from 'vitest'
import { createBudgetApi, type BudgetApi } from './api.ts'
import { changeLog, listMessages, type ChangeMessage } from './changes.ts'
import { emptyTrie, insertTimestamp, type TrieNode } from './merkle.ts'
import type { StorageAdapter } from './storage.ts'
import {
  applyMessages,
  SyncError,
  type RangePage,
  type SyncRequest,
  type SyncResponse,
  type SyncTransport,
} from './sync.ts'
import { openMemoryAdapter } from './test-utils.ts'

const A = '0123456789abcdef'
const B = 'fedcba9876543210'
const T0 = Date.parse('2026-10-28T12:00:00.000Z')

/** The server's behaviour in memory, close enough to apps/api to exercise the protocol. */
class FakeServer implements SyncTransport {
  log: { seq: number; message: ChangeMessage }[] = []
  down = false
  calls = 0

  private build(): TrieNode {
    const t = emptyTrie()
    for (const { message } of this.log) insertTimestamp(t, message.timestamp)
    return t
  }

  async sync(req: SyncRequest): Promise<SyncResponse> {
    this.calls++
    if (this.down) throw new SyncError('Could not reach the server')
    for (const message of req.messages) {
      if (!this.log.some((e) => e.message.timestamp === message.timestamp)) {
        this.log.push({ seq: this.log.length + 1, message })
      }
    }
    const max = this.log.length
    const cursor = Math.min(req.cursor, max)
    const page = this.log.filter((e) => e.seq > cursor).slice(0, 3)
    return {
      messages: page.map((e) => e.message),
      cursor: page.length ? page[page.length - 1]!.seq : cursor,
      hasMore: this.log.filter((e) => e.seq > cursor).length > page.length,
      root: this.build().hash,
    }
  }

  async trie(): Promise<TrieNode> {
    return this.build()
  }

  async messagesFrom(from: string, after: number): Promise<RangePage> {
    const rows = this.log.filter((e) => e.seq > after && e.message.timestamp >= from)
    const page = rows.slice(0, 2)
    return {
      messages: page.map((e) => e.message),
      next: rows.length > page.length ? page[page.length - 1]!.seq : null,
    }
  }
}
class Device {
  clock = T0
  readonly adapter: StorageAdapter
  readonly api: BudgetApi
  readonly id: string

  constructor(adapter: StorageAdapter, api: BudgetApi, id: string) {
    this.adapter = adapter
    this.api = api
    this.id = id
  }

  static async create(id: string, server: SyncTransport) {
    const adapter = await openMemoryAdapter()
    let n = 0
    const device: Device = new Device(
      adapter,
      createBudgetApi({
        adapter,
        storage: 'memory',
        sqliteVersion: 'test',
        deviceId: id,
        newId: () => `${id.slice(0, 2)}-${++n}`,
        now: () => new Date(device.clock).toISOString(),
        syncTransport: server,
      }),
      id,
    )
    return device
  }

  async accounts() {
    return this.adapter.query('SELECT id, name, type, closed FROM accounts ORDER BY id')
  }
}

let server: FakeServer
let a: Device
let b: Device

beforeEach(async () => {
  server = new FakeServer()
  a = await Device.create(A, server)
  b = await Device.create(B, server)
})

describe('sync between two devices', () => {
  it('delivers a created row, whole, to a device that has nothing', async () => {
    await a.api.createAccount({ name: 'Checking', type: 'checking' })
    const first = await a.api.syncNow()
    expect(first).toMatchObject({ pushed: 5, converged: true, failed: [] })
    const second = await b.api.syncNow()
    expect(second).toMatchObject({ pushed: 0, pulled: 5, converged: true })
    expect(await b.accounts()).toEqual(await a.accounts())
    expect(await b.accounts()).toHaveLength(1)
  })

  it('merges rows each device added offline', async () => {
    await a.api.createAccount({ name: 'From A', type: 'checking' })
    await b.api.createAccount({ name: 'From B', type: 'savings' })
    await a.api.syncNow()
    await b.api.syncNow()
    await a.api.syncNow()
    expect(await a.accounts()).toEqual(await b.accounts())
    expect(await a.accounts()).toHaveLength(2)
  })

  it('lets the newest edit to a field win on both devices, whoever syncs first', async () => {
    const acct = await a.api.createAccount({ name: 'Checking', type: 'checking' })
    await a.api.syncNow()
    await b.api.syncNow()

    a.clock = T0 + 10_000
    b.clock = T0 + 20_000
    await a.api.updateAccount(acct.id, { name: 'Edited by A' })
    await b.api.updateAccount(acct.id, { name: 'Edited by B' })
    // B's edit is newer, but A syncs last: arrival order must not matter.
    await b.api.syncNow()
    await a.api.syncNow()
    await b.api.syncNow()
    expect((await a.accounts())[0]).toMatchObject({ name: 'Edited by B' })
    expect(await a.accounts()).toEqual(await b.accounts())
  })

  it('keeps edits to different fields of one row from both devices', async () => {
    const acct = await a.api.createAccount({ name: 'Checking', type: 'checking' })
    await a.api.syncNow()
    await b.api.syncNow()
    await a.api.updateAccount(acct.id, { name: 'Renamed' })
    await b.api.updateAccount(acct.id, { closed: true })
    await a.api.syncNow()
    await b.api.syncNow()
    await a.api.syncNow()
    expect(await a.accounts()).toEqual(await b.accounts())
    expect((await a.accounts())[0]).toMatchObject({ name: 'Renamed', closed: 1 })
  })

  it('propagates a delete, and a later edit elsewhere does not bring the row back', async () => {
    const acct = await a.api.createAccount({ name: 'Old', type: 'checking' })
    await a.api.syncNow()
    await b.api.syncNow()
    a.clock = T0 + 5_000
    await a.api.deleteAccount(acct.id)
    b.clock = T0 + 9_000
    await b.api.updateAccount(acct.id, { name: 'Edited after delete' })
    await a.api.syncNow()
    await b.api.syncNow()
    await a.api.syncNow()
    expect(await a.accounts()).toEqual([])
    expect(await b.accounts()).toEqual([])
  })

  it('makes later local writes sort after everything received', async () => {
    b.clock = T0 + 60_000
    await b.api.createAccount({ name: 'Future-ish', type: 'checking' })
    await b.api.syncNow()
    a.clock = T0 // A's clock is a minute behind B's
    await a.api.syncNow()
    await a.api.createAccount({ name: 'Mine', type: 'checking' })
    const stamps = (await listMessages(a.adapter)).map((m) => m.timestamp)
    expect(stamps).toEqual([...stamps].sort())
    const mine = (await listMessages(a.adapter)).filter((m) => m.deviceId === A)
    const theirs = (await listMessages(a.adapter)).filter((m) => m.deviceId === B)
    expect(mine[0]!.timestamp > theirs.at(-1)!.timestamp).toBe(true)
  })

  it('tracks how many local changes the server lacks', async () => {
    expect(await a.api.getSyncStatus()).toEqual({ pending: 0, lastSyncAt: null })
    await a.api.createAccount({ name: 'Checking', type: 'checking' })
    expect((await a.api.getSyncStatus()).pending).toBe(5)
    await a.api.syncNow()
    expect(await a.api.getSyncStatus()).toEqual({
      pending: 0,
      lastSyncAt: new Date(T0).toISOString(),
    })
  })

  it('keeps changes pending when the server is unreachable, and sends them later', async () => {
    await a.api.createAccount({ name: 'Checking', type: 'checking' })
    server.down = true
    await expect(a.api.syncNow()).rejects.toThrow('Could not reach the server')
    expect((await a.api.getSyncStatus()).pending).toBe(5)
    server.down = false
    await a.api.syncNow()
    expect((await a.api.getSyncStatus()).pending).toBe(0)
    await b.api.syncNow()
    expect(await b.accounts()).toHaveLength(1)
  })

  it('a second sync with nothing new moves nothing', async () => {
    await a.api.createAccount({ name: 'Checking', type: 'checking' })
    await a.api.syncNow()
    expect(await a.api.syncNow()).toMatchObject({ pushed: 0, pulled: 0, converged: true })
  })

  it('pushes more than one batch of changes', async () => {
    for (let i = 0; i < 120; i++) await a.api.createAccount({ name: `A${i}`, type: 'checking' })
    const result = await a.api.syncNow()
    expect(result.pushed).toBe(600)
    await b.api.syncNow()
    expect(await b.accounts()).toHaveLength(120)
  })

  it('joins a sync already in progress instead of running two', async () => {
    await a.api.createAccount({ name: 'Checking', type: 'checking' })
    const [one, two] = await Promise.all([a.api.syncNow(), a.api.syncNow()])
    expect(one).toEqual(two)
    expect(server.log).toHaveLength(5)
  })

  it('repairs a server that lost messages, by re-sending from where the tries differ', async () => {
    await a.api.createAccount({ name: 'One', type: 'checking' })
    a.clock = T0 + 5 * 60_000
    await a.api.createAccount({ name: 'Two', type: 'savings' })
    await a.api.syncNow()
    // The server is restored from an older copy: the second account's messages are gone.
    server.log = server.log.filter(
      (e) => Date.parse(e.message.timestamp.slice(0, 24)) < T0 + 60_000,
    )
    const result = await a.api.syncNow()
    expect(result).toMatchObject({ repaired: true, converged: true })
    expect(server.log).toHaveLength(10)
    await b.api.syncNow()
    expect(await b.accounts()).toHaveLength(2)
  })

  it('repairs a device that missed messages the server holds', async () => {
    await b.api.createAccount({ name: 'Elsewhere', type: 'checking' })
    await b.api.syncNow()
    // A's cursor claims it has everything, but its file does not (e.g. restored from backup).
    await a.adapter.exec("INSERT INTO sync_state (key, value) VALUES ('server_cursor', '5')")
    const result = await a.api.syncNow()
    expect(result).toMatchObject({ repaired: true, converged: true })
    expect(await a.accounts()).toEqual(await b.accounts())
  })
})

describe('applyMessages', () => {
  const stamp = (n: number, node = B) =>
    `2026-10-28T12:00:${String(n).padStart(2, '0')}.000Z-0000-${node}`
  const msg = (
    n: number,
    column: string,
    value: ChangeMessage['value'],
    over: Partial<ChangeMessage> = {},
  ): ChangeMessage => ({
    timestamp: stamp(n),
    table: 'accounts',
    rowId: 'acct',
    column,
    value,
    deviceId: B,
    ...over,
  })
  const row = (n: number) => [
    msg(n, 'name', 'Checking'),
    msg(n + 1, 'type', 'checking'),
    msg(n + 2, 'on_budget', 1),
    msg(n + 3, 'created_at', '2026-01-01T00:00:00.000Z'),
  ]
  const apply = async (adapter: StorageAdapter, messages: ChangeMessage[]) =>
    adapter.transaction((tx) => applyMessages(tx, messages, { wallMs: T0 }))

  let adapter: StorageAdapter
  beforeEach(async () => {
    adapter = await openMemoryAdapter()
  })

  it('gives the same row whatever order the messages arrive in', async () => {
    const all = [...row(1), msg(10, 'name', 'Newest'), msg(7, 'name', 'Older')]
    const other = await openMemoryAdapter()
    await apply(adapter, all)
    await apply(other, [...all].reverse())
    const read = (db: StorageAdapter) => db.query('SELECT name FROM accounts')
    expect(await read(adapter)).toEqual([{ name: 'Newest' }])
    expect(await read(other)).toEqual([{ name: 'Newest' }])
  })

  it('counts and stores a message once', async () => {
    expect((await apply(adapter, row(1))).applied).toBe(4)
    expect((await apply(adapter, row(1))).applied).toBe(0)
    expect(await listMessages(adapter)).toHaveLength(4)
  })

  it('marks received messages as synced', async () => {
    await apply(adapter, row(1))
    expect(await adapter.query('SELECT COUNT(*) AS n FROM messages WHERE synced = 0')).toEqual([
      { n: 0 },
    ])
  })

  it('waits for the rest of a row split across batches', async () => {
    await apply(adapter, row(1).slice(0, 2))
    expect(await adapter.query('SELECT * FROM accounts')).toEqual([])
    await apply(adapter, row(1).slice(2))
    expect(await adapter.query('SELECT name, type FROM accounts')).toEqual([
      { name: 'Checking', type: 'checking' },
    ])
  })

  it('settles a child that arrives before its parent within a batch', async () => {
    const group = [
      msg(1, 'name', 'Bills', { table: 'category_groups', rowId: 'g' }),
      msg(2, 'sort', 0, { table: 'category_groups', rowId: 'g' }),
      msg(3, 'created_at', 'x', { table: 'category_groups', rowId: 'g' }),
    ]
    const cat = [
      msg(4, 'group_id', 'g', { table: 'categories', rowId: 'c' }),
      msg(5, 'name', 'Rent', { table: 'categories', rowId: 'c' }),
      msg(6, 'sort', 0, { table: 'categories', rowId: 'c' }),
      msg(7, 'created_at', 'x', { table: 'categories', rowId: 'c' }),
    ]
    const result = await apply(adapter, [...cat, ...group])
    expect(result.failed).toEqual([])
    expect(await adapter.query('SELECT name FROM categories')).toEqual([{ name: 'Rent' }])
  })

  it('reports a row the database refuses, keeps its messages, and applies the rest', async () => {
    const bad = [
      ...row(1).slice(0, 3),
      msg(4, 'created_at', 'x'),
      msg(5, 'type', 'investment'), // an investment account must be off-budget
    ]
    const good = row(10).map((m) => ({ ...m, rowId: 'fine' }))
    const result = await apply(adapter, [...bad, ...good])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ table: 'accounts', rowId: 'acct' })
    expect(await adapter.query('SELECT id FROM accounts')).toEqual([{ id: 'fine' }])
    expect(await listMessages(adapter)).toHaveLength(bad.length + good.length)
  })

  it.each([
    ['a table that is not synced', { table: 'messages' }],
    ['a table that does not exist', { table: 'goals' }],
    ['a column the schema lacks', { column: 'colour' }],
    ['the id column', { column: 'id' }],
    ['a timestamp far in the future', { timestamp: '2027-01-01T00:00:00.000Z-0000-' + B }],
    ['a device id that is not the timestamp node', { deviceId: A }],
    ['a malformed timestamp', { timestamp: 'later' }],
  ])('refuses %s, storing nothing', async (_name, over) => {
    await expect(
      apply(adapter, [msg(1, 'name', 'X', over as Partial<ChangeMessage>)]),
    ).rejects.toThrow()
    expect(await listMessages(adapter)).toEqual([])
  })

  it('does not change the local log when a local write follows a merge', async () => {
    await apply(adapter, row(1))
    const log = adapter.transaction((tx) =>
      changeLog(tx, { deviceId: A, now: () => '2026-10-28T12:30:00.000Z' }).update(
        'accounts',
        'acct',
        {
          name: 'Mine',
        },
      ),
    )
    await log
    const last = (await listMessages(adapter)).at(-1)!
    expect(last).toMatchObject({ column: 'name', value: 'Mine', deviceId: A })
    expect(await adapter.query('SELECT COUNT(*) AS n FROM messages WHERE synced = 0')).toEqual([
      { n: 1 },
    ])
  })
})
