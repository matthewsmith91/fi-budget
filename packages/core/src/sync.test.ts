import { beforeEach, describe, expect, it } from 'vitest'
import { createBudgetApi, type BudgetApi } from './api.ts'
import { changeLog, listMessages, type ChangeMessage } from './changes.ts'
import { emptyTrie, insertTimestamp, type TrieNode } from './merkle.ts'
import type { StorageAdapter } from './storage.ts'
import {
  applyMessages,
  FILE_REFRESH_AFTER,
  httpSyncTransport,
  SyncError,
  type RangePage,
  type ServerInfo,
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
  file: { bytes: Uint8Array; cursor: number } | null = null
  uploads = 0
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
      fileCursor: this.file?.cursor ?? null,
    }
  }

  async info(): Promise<ServerInfo> {
    if (this.down) throw new SyncError('Could not reach the server')
    return {
      messages: this.log.length,
      file: this.file && {
        cursor: this.file.cursor,
        size: this.file.bytes.length,
        createdAt: new Date(T0).toISOString(),
      },
    }
  }

  async downloadFile() {
    return this.file
  }

  async uploadFile(bytes: Uint8Array, cursor: number): Promise<void> {
    if (this.down) throw new SyncError('Could not reach the server')
    if (this.file && cursor < this.file.cursor) throw new SyncError('Newer file held', 409)
    this.uploads++
    this.file = { bytes, cursor }
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
  // Both have been on the server before, as in daily use; first contact is tested separately.
  await a.api.syncNow()
  await b.api.syncNow()
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

  it('ends up with one payment-category group when both devices add a card offline', async () => {
    await a.api.createAccount({ name: 'Visa', type: 'credit' })
    await b.api.createAccount({ name: 'Amex', type: 'credit' })
    await a.api.syncNow()
    await b.api.syncNow()
    await a.api.syncNow()
    for (const device of [a, b]) {
      const groups = await device.api.listCategoryGroups()
      expect(groups.map((g) => g.id)).toEqual(['credit-card-payments'])
      expect(groups[0]!.categories.map((c) => c.name).sort()).toEqual(['Amex', 'Visa'])
    }
  })

  it('delivers both legs of a transfer still paired', async () => {
    const checking = await a.api.createAccount({ name: 'Checking', type: 'checking' })
    const savings = await a.api.createAccount({ name: 'Savings', type: 'savings' })
    await a.api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-10-28',
      amount: 12500,
    })
    await a.api.syncNow()
    await b.api.syncNow()
    const theirs = await b.api.listTransactions()
    expect(theirs.map((t) => [t.accountId, t.amount, t.transferAccountId])).toEqual([
      [savings.id, 12500, checking.id],
      [checking.id, -12500, savings.id],
    ])
    expect(await b.api.getAccountBalances()).toEqual(await a.api.getAccountBalances())
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
    const never = await Device.create('1111111111111111', server)
    expect(await never.api.getSyncStatus()).toEqual({
      linked: false,
      pending: 0,
      lastSyncAt: null,
    })
    await a.api.createAccount({ name: 'Checking', type: 'checking' })
    expect((await a.api.getSyncStatus()).pending).toBe(5)
    await a.api.syncNow()
    expect(await a.api.getSyncStatus()).toEqual({
      linked: true,
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
    await a.adapter.exec("UPDATE sync_state SET value = '5' WHERE key = 'server_cursor'")
    const result = await a.api.syncNow()
    expect(result).toMatchObject({ repaired: true, converged: true })
    expect(await a.accounts()).toEqual(await b.accounts())
  })
})

describe('full budget file', () => {
  const household = (d: Device) => d.api.createHousehold({ name: 'Smith', members: ['Matt'] })

  /** A device that has never been to the server. */
  const fresh = (id: string) => Device.create(id, server)

  it('is uploaded by the first device to turn on sync, with the log position it holds', async () => {
    const solo = await fresh('1111111111111111')
    await household(solo)
    await solo.api.createAccount({ name: 'Checking', type: 'checking' })

    const result = await solo.api.syncNow()

    expect(result).toMatchObject({ converged: true, uploadedFile: true })
    expect(server.file?.cursor).toBe(server.log.length)
    expect(server.uploads).toBe(1)
  })

  it('is not re-uploaded while the server’s copy is recent', async () => {
    const solo = await fresh('1111111111111111')
    await household(solo)
    await solo.api.syncNow()
    await solo.api.createAccount({ name: 'Checking', type: 'checking' })
    const result = await solo.api.syncNow()
    expect(result.uploadedFile).toBe(false)
    expect(server.uploads).toBe(1)
  })

  it('is refreshed once the server’s copy falls far behind the log', async () => {
    await household(a)
    await a.api.syncNow()
    const stale = server.file!.cursor
    const first = server.log.length + 1
    server.log.push(
      ...Array.from({ length: FILE_REFRESH_AFTER }, (_, i) => ({
        seq: first + i,
        message: {
          timestamp: new Date(T0 + 1000 + i).toISOString() + '-0000-' + B,
          table: 'accounts',
          rowId: `bulk-${i}`,
          column: 'name',
          value: `Bulk ${i}`,
          deviceId: B,
        },
      })),
    )
    const result = await a.api.syncNow()
    expect(result.uploadedFile).toBe(true)
    expect(server.file!.cursor).toBeGreaterThanOrEqual(stale + FILE_REFRESH_AFTER)
  })

  it('sets a new device up with the household, then syncs only what came after', async () => {
    await household(a)
    const checking = await a.api.createAccount({ name: 'Checking', type: 'checking' })
    await a.api.syncNow()
    a.clock += 1000
    await a.api.createAccount({ name: 'Savings', type: 'savings' })
    await a.api.syncNow() // not enough to refresh the file: it now lags by the Savings account

    const phone = await fresh('2222222222222222')
    const setup = await phone.api.getSyncSetup()
    expect(setup).toMatchObject({ linked: false, hasBudget: false })
    expect(setup.server.file).not.toBeNull()

    const result = await phone.api.downloadServerBudget()

    // The file carried the household and Checking; the Savings account arrived as a change.
    expect(result.sync.pulled).toBeGreaterThan(0)
    expect(result.sync.pulled).toBeLessThan(server.log.length)
    expect((await phone.api.getHousehold())?.name).toBe('Smith')
    expect(await phone.accounts()).toEqual(await a.accounts())
    expect((await phone.accounts()).map((r) => r.id)).toContain(checking.id)
    expect(await phone.api.getSyncSetup()).toMatchObject({ linked: true, hasBudget: true })
  })

  it('leaves the new device in step with the others afterwards', async () => {
    await household(a)
    await a.api.syncNow()
    const phone = await fresh('2222222222222222')
    await phone.api.downloadServerBudget()

    phone.clock += 1000
    await phone.api.createAccount({ name: 'From phone', type: 'checking' })
    await phone.api.syncNow()
    await a.api.syncNow()

    expect(await a.accounts()).toEqual(await phone.accounts())
    expect(await a.accounts()).toHaveLength(1)
    expect(await phone.api.getSyncStatus()).toMatchObject({ pending: 0 })
  })

  it('keeps changes the uploading device had not sent yet, and sends them from the new one', async () => {
    await household(a)
    await a.api.syncNow()
    a.clock += 1000
    // A change made after the last sync is in the file as an unsent message.
    await a.api.createAccount({ name: 'Unsent', type: 'checking' })
    server.file = { bytes: await a.adapter.exportFile(), cursor: server.log.length }

    const phone = await fresh('2222222222222222')
    await phone.api.downloadServerBudget()
    expect((await phone.accounts()).map((r) => r.name)).toEqual(['Unsent'])
    await a.api.syncNow()

    expect(await phone.api.getSyncStatus()).toMatchObject({ pending: 0 })
    expect(server.log.filter((e) => e.message.value === 'Unsent')).toHaveLength(1)
  })

  describe('refuses', () => {
    it('to merge a device’s own budget into a different one on the server', async () => {
      await household(a)
      await a.api.syncNow()
      const other = await fresh('3333333333333333')
      await household(other)

      await expect(other.api.syncNow()).rejects.toMatchObject({ status: 409 })

      expect(await other.api.getSyncSetup()).toMatchObject({ linked: false, hasBudget: true })
      expect(server.log.every((e) => e.message.deviceId !== '3333333333333333')).toBe(true)
      expect(await other.api.getSyncStatus()).not.toMatchObject({ pending: 0 })
    })

    it('then lets that device replace its budget with the server’s, keeping a backup', async () => {
      await household(a)
      await a.api.syncNow()
      const other = await fresh('3333333333333333')
      await other.api.createHousehold({ name: 'Not ours', members: ['Someone'] })

      const result = await other.api.downloadServerBudget()

      expect(result.safetyBackup.length).toBeGreaterThan(0)
      expect((await other.api.getHousehold())?.name).toBe('Smith')
    })

    it('a download when the server has no file yet, leaving the device untouched', async () => {
      const phone = await fresh('2222222222222222')
      await household(phone)
      await expect(phone.api.downloadServerBudget()).rejects.toMatchObject({ status: 404 })
      expect((await phone.api.getHousehold())?.name).toBe('Smith')
    })

    it('a corrupt file, restoring the device’s own budget', async () => {
      server.file = { bytes: new TextEncoder().encode('not a database'), cursor: 0 }
      const phone = await fresh('2222222222222222')
      await household(phone)
      await expect(phone.api.downloadServerBudget()).rejects.toThrow()
      expect((await phone.api.getHousehold())?.name).toBe('Smith')
    })
  })

  it('does not fail a sync when the file cannot be sent', async () => {
    const solo = await fresh('1111111111111111')
    await household(solo)
    server.uploadFile = async () => {
      throw new SyncError('The file is too large', 413)
    }
    const result = await solo.api.syncNow()
    expect(result).toMatchObject({ converged: true, uploadedFile: false })
    expect(result.fileError).toBe('The file is too large')
    expect(server.log.length).toBeGreaterThan(0)
  })

  it('treats a stale-file conflict from another device as harmless', async () => {
    const solo = await fresh('1111111111111111')
    await household(solo)
    server.file = { bytes: new Uint8Array(4), cursor: 999 }
    server.uploadFile = async () => {
      throw new SyncError('The server already has a newer budget file', 409)
    }
    const result = await solo.api.syncNow()
    expect(result.uploadedFile).toBe(false)
    expect(result.fileError).toBeUndefined()
  })

  it('does not upload an empty device’s file', async () => {
    expect(server.file).toBeNull()
    expect(server.uploads).toBe(0)
  })
})

describe('httpSyncTransport files', () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const transport = (respond: (url: string, init?: RequestInit) => Response) =>
    httpSyncTransport({
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        return respond(String(url), init)
      },
    })
  beforeEach(() => {
    calls.length = 0
  })

  it('downloads the bytes with the log position from the header', async () => {
    const t = transport(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'x-budget-cursor': '42' } }),
    )
    expect(await t.downloadFile()).toEqual({ bytes: new Uint8Array([1, 2, 3]), cursor: 42 })
    expect(calls[0]!.url).toBe('/api/sync/file')
  })

  it('reports no file as null, not an error', async () => {
    const t = transport(() => Response.json({ error: 'none' }, { status: 404 }))
    expect(await t.downloadFile()).toBeNull()
  })

  it('refuses a download that lacks its position', async () => {
    const t = transport(() => new Response(new Uint8Array([1])))
    await expect(t.downloadFile()).rejects.toBeInstanceOf(SyncError)
  })

  it('uploads raw bytes with the cursor in the query', async () => {
    const t = transport(() => Response.json({ cursor: 7, size: 3 }))
    await t.uploadFile(new Uint8Array([1, 2, 3]), 7)
    expect(calls[0]!.url).toBe('/api/sync/file?cursor=7')
    expect(calls[0]!.init).toMatchObject({ method: 'PUT' })
    expect(new Headers(calls[0]!.init!.headers).get('content-type')).toBe(
      'application/octet-stream',
    )
  })

  it('surfaces the server’s reason when an upload is refused', async () => {
    const t = transport(() => Response.json({ error: 'Newer file held' }, { status: 409 }))
    await expect(t.uploadFile(new Uint8Array(1), 1)).rejects.toMatchObject({
      message: 'Newer file held',
      status: 409,
    })
  })

  it('asks the server what it holds', async () => {
    const t = transport(() => Response.json({ messages: 3, file: null }))
    expect(await t.info()).toEqual({ messages: 3, file: null })
    expect(calls[0]!.url).toBe('/api/sync/info')
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
