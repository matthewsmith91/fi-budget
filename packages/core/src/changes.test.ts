import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { changeLog, DELETED_COLUMN, listMessages } from './changes.ts'
import { parseHlc } from './hlc.ts'
import { openMemoryAdapter } from './test-utils.ts'

const DEVICE = '0123456789abcdef'
const OTHER = 'fedcba9876543210'

async function setup(opts: { now?: () => string; deviceId?: string } = {}) {
  const adapter = await openMemoryAdapter()
  let n = 0
  const api = createBudgetApi({
    adapter,
    storage: 'memory',
    sqliteVersion: 'test',
    deviceId: opts.deviceId ?? DEVICE,
    newId: () => `id-${++n}`,
    now: opts.now ?? (() => '2026-01-01T00:00:00.000Z'),
  })
  return { api, adapter, messages: () => listMessages(adapter) }
}

const brief = (ms: Awaited<ReturnType<typeof listMessages>>) =>
  ms.map((m) => [m.table, m.rowId, m.column, m.value])

describe('change messages', () => {
  it('start empty on a fresh file', async () => {
    const { messages } = await setup()
    expect(await messages()).toEqual([])
  })

  it('a create logs one message per column, with the device id', async () => {
    const { api, messages } = await setup()
    await api.createAccount({ name: 'Checking', type: 'checking' })
    const all = await messages()
    expect(brief(all)).toEqual([
      ['accounts', 'id-1', 'name', 'Checking'],
      ['accounts', 'id-1', 'type', 'checking'],
      ['accounts', 'id-1', 'on_budget', 1],
      ['accounts', 'id-1', 'closed', 0],
      ['accounts', 'id-1', 'created_at', '2026-01-01T00:00:00.000Z'],
    ])
    expect(all.every((m) => m.deviceId === DEVICE)).toBe(true)
  })

  it('timestamps are valid HLCs, unique and increasing even when the clock stands still', async () => {
    const { api, messages } = await setup()
    await api.createAccount({ name: 'A', type: 'checking' })
    await api.createAccount({ name: 'B', type: 'savings' })
    const stamps = (await messages()).map((m) => m.timestamp)
    expect(new Set(stamps).size).toBe(stamps.length)
    expect(stamps).toEqual([...stamps].sort())
    for (const s of stamps) expect(parseHlc(s).node).toBe(DEVICE)
    expect(parseHlc(stamps[0]!).counter).toBe(0)
    expect(parseHlc(stamps.at(-1)!).counter).toBe(stamps.length - 1)
  })

  it('an update logs only the fields that changed; a no-op logs nothing', async () => {
    const { api, messages } = await setup()
    const a = await api.createAccount({ name: 'Checking', type: 'checking' })
    const before = (await messages()).length
    await api.updateAccount(a.id, { name: 'Main', closed: false })
    expect(brief((await messages()).slice(before))).toEqual([['accounts', a.id, 'name', 'Main']])
    await api.updateAccount(a.id, { name: 'Main' })
    expect(await messages()).toHaveLength(before + 1)
  })

  it('a delete logs a tombstone', async () => {
    const { api, messages } = await setup()
    const a = await api.createAccount({ name: 'Checking', type: 'checking' })
    await api.deleteAccount(a.id)
    expect((await messages()).at(-1)).toMatchObject({
      table: 'accounts',
      rowId: a.id,
      column: DELETED_COLUMN,
      value: 1,
    })
  })

  it('logs household, groups and categories, including reorder and move', async () => {
    const { api, messages } = await setup()
    await api.createHousehold({ name: 'Smith', members: ['Matt', 'Jessica'] })
    const g1 = await api.createCategoryGroup({ name: 'Bills' })
    const g2 = await api.createCategoryGroup({ name: 'Fun' })
    const c = await api.createCategory({ groupId: g1.id, name: 'Rent' })
    const tables = new Set((await messages()).map((m) => m.table))
    expect(tables).toEqual(new Set(['households', 'members', 'category_groups', 'categories']))

    const before = (await messages()).length
    await api.reorderCategoryGroups([g2.id, g1.id])
    expect(brief((await messages()).slice(before))).toEqual([
      ['category_groups', g2.id, 'sort', 0],
      ['category_groups', g1.id, 'sort', 1],
    ])
    await api.createCategory({ groupId: g2.id, name: 'Games' })
    const afterReorder = (await messages()).length
    await api.updateCategory(c.id, { groupId: g2.id })
    expect(brief((await messages()).slice(afterReorder))).toEqual([
      ['categories', c.id, 'group_id', g2.id],
      ['categories', c.id, 'sort', 1],
    ])
  })

  it('a rejected write leaves no messages behind', async () => {
    const { api, messages } = await setup()
    await api.createAccount({ name: 'Checking', type: 'checking' })
    const before = (await messages()).length
    await expect(api.createAccount({ name: 'checking', type: 'savings' })).rejects.toThrow()
    expect(await messages()).toHaveLength(before)
  })

  it('replaying the log reproduces the data', async () => {
    const { api, adapter, messages } = await setup()
    const g = await api.createCategoryGroup({ name: 'Bills' })
    const c = await api.createCategory({ groupId: g.id, name: 'Rent', needOrWant: 'need' })
    await api.updateCategory(c.id, { name: 'Mortgage', hidden: true })
    await api.createCategory({ groupId: g.id, name: 'Power' })
    await api.deleteCategory(c.id)

    // newest-wins per field, which is what a sync peer would do
    const folded = new Map<string, Record<string, unknown>>()
    for (const m of await messages()) {
      if (m.table !== 'categories') continue
      const row = folded.get(m.rowId) ?? {}
      row[m.column] = m.value
      folded.set(m.rowId, row)
    }
    const live = [...folded].filter(([, r]) => !r[DELETED_COLUMN])
    const rows = await adapter.query('SELECT id, name, hidden, sort FROM categories')
    expect(live.map(([id, r]) => ({ id, name: r.name, hidden: r.hidden, sort: r.sort }))).toEqual(
      rows,
    )
  })

  it('continues after the newest timestamp already in the file, even from another device', async () => {
    const { api, adapter, messages } = await setup()
    await adapter.exec(
      `INSERT INTO messages (timestamp, table_name, row_id, column_name, value, device_id)
       VALUES ('2026-01-01T00:00:30.000Z-0005-${OTHER}', 'accounts', 'x', 'name', 'Remote', '${OTHER}')`,
    )
    await api.createAccount({ name: 'Local', type: 'checking' })
    const mine = (await messages()).filter((m) => m.deviceId === DEVICE)
    expect(mine[0]!.timestamp).toBe(`2026-01-01T00:00:30.000Z-0006-${DEVICE}`)
  })

  it('follows the wall clock forward and ignores it going backwards', async () => {
    let t = Date.parse('2026-01-01T00:00:10.000Z')
    const { api, messages } = await setup({ now: () => new Date(t).toISOString() })
    await api.createAccount({ name: 'A', type: 'checking' })
    t = Date.parse('2026-01-01T00:00:05.000Z')
    await api.createAccount({ name: 'B', type: 'checking' })
    t = Date.parse('2026-01-01T00:01:00.000Z')
    await api.createAccount({ name: 'C', type: 'checking' })
    const stamps = (await messages()).map((m) => m.timestamp)
    expect(stamps).toEqual([...stamps].sort())
    expect(parseHlc(stamps.at(-1)!)).toMatchObject({ ms: t, counter: 4 })
  })

  it('survives a JSON export and import', async () => {
    const a = await setup()
    await a.api.createAccount({ name: 'Checking', type: 'checking' })
    const json = await a.api.exportJson()
    const b = await setup()
    await b.api.importJson(json)
    expect(await b.messages()).toEqual(await a.messages())
  })

  it('listMessages pages by timestamp', async () => {
    const { api, adapter, messages } = await setup()
    await api.createAccount({ name: 'Checking', type: 'checking' })
    const all = await messages()
    const rest = await listMessages(adapter, { after: all[1]!.timestamp, limit: 2 })
    expect(rest).toEqual(all.slice(2, 4))
  })

  it('rejects identifiers that are not plain names', async () => {
    const { adapter } = await setup()
    const log = changeLog(adapter, { deviceId: DEVICE, now: () => '2026-01-01T00:00:00.000Z' })
    await expect(log.insert('accounts"; DROP TABLE accounts; --', { id: 'x' })).rejects.toThrow(
      /Invalid identifier/,
    )
  })
})
