import { describe, expect, it } from 'vitest'
import type { CategoryBalance } from './allocations.ts'
import { createBudgetApi } from './api.ts'
import { openMemoryAdapter } from './test-utils.ts'

async function makeApi() {
  const adapter = await openMemoryAdapter()
  let n = 0
  const api = createBudgetApi({
    adapter,
    storage: 'memory',
    sqliteVersion: 'test',
    newId: () => `id-${++n}`,
    now: () => '2026-01-01T00:00:00.000Z',
  })
  const group = await api.createCategoryGroup({ name: 'Bills' })
  const rent = await api.createCategory({ groupId: group.id, name: 'Rent' })
  const food = await api.createCategory({ groupId: group.id, name: 'Food' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  let t = 0
  /** Test-only stand-in until transaction entry exists: a one-split transaction. */
  async function spend(accountId: string, date: string, categoryId: string | null, amount: number) {
    const id = `tx-${++t}`
    await adapter.exec(
      'INSERT INTO transactions (id, account_id, date, amount, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, accountId, date, amount, 'now'],
    )
    await adapter.exec(
      'INSERT INTO transaction_splits (id, transaction_id, category_id, amount, created_at) VALUES (?, ?, ?, ?, ?)',
      [`${id}-s`, id, categoryId, amount, 'now'],
    )
  }
  return { api, adapter, rent, food, checking, spend }
}

const balance = (rows: CategoryBalance[], id: string) => rows.find((r) => r.categoryId === id)

describe('allocations', () => {
  it('records manual allocations in the ledger', async () => {
    const { api, rent } = await makeApi()
    const a = await api.allocate({
      month: '2026-01',
      categoryId: rent.id,
      amount: 150000,
      note: ' Jan ',
    })
    expect(a).toMatchObject({
      month: '2026-01',
      categoryId: rent.id,
      goalId: null,
      amount: 150000,
      source: 'manual',
      note: 'Jan',
    })
    await api.allocate({ month: '2026-02', categoryId: rent.id, amount: -5000 })
    expect((await api.listAllocations()).map((x) => x.amount)).toEqual([150000, -5000])
    expect(await api.listAllocations({ month: '2026-02' })).toHaveLength(1)
    expect(await api.listAllocations({ categoryId: 'other' })).toEqual([])
  })

  it('validates input', async () => {
    const { api, rent } = await makeApi()
    const ok = { month: '2026-01', categoryId: rent.id, amount: 100 }
    await expect(api.allocate({ ...ok, month: '2026-13' })).rejects.toThrow(/month/)
    await expect(api.allocate({ ...ok, month: '2026-1' })).rejects.toThrow(/month/)
    await expect(api.allocate({ ...ok, amount: 0 })).rejects.toThrow(/zero/)
    await expect(api.allocate({ ...ok, amount: 1.5 })).rejects.toThrow(/cents/)
    await expect(api.allocate({ ...ok, categoryId: 'nope' })).rejects.toThrow(/not found/)
    expect(await api.listAllocations()).toEqual([])
  })

  it('moves money as a pair of entries that net to zero', async () => {
    const { api, rent, food } = await makeApi()
    await api.allocate({ month: '2026-01', categoryId: rent.id, amount: 10000 })
    const [out, into] = await api.moveAllocation({
      month: '2026-01',
      fromCategoryId: rent.id,
      toCategoryId: food.id,
      amount: 2500,
      note: 'groceries',
    })
    expect(out).toMatchObject({ categoryId: rent.id, amount: -2500, source: 'move' })
    expect(into).toMatchObject({ categoryId: food.id, amount: 2500, source: 'move' })
    const rows = await api.getMonthBalances('2026-01')
    expect(balance(rows, rent.id)).toMatchObject({ assigned: 7500, available: 7500 })
    expect(balance(rows, food.id)).toMatchObject({ assigned: 2500, available: 2500 })
  })

  it('rejects bad moves without writing half a pair', async () => {
    const { api, rent, food } = await makeApi()
    const base = { month: '2026-01', fromCategoryId: rent.id, toCategoryId: food.id, amount: 100 }
    await expect(api.moveAllocation({ ...base, toCategoryId: rent.id })).rejects.toThrow(
      /different/,
    )
    await expect(api.moveAllocation({ ...base, amount: -100 })).rejects.toThrow(/positive/)
    await expect(api.moveAllocation({ ...base, toCategoryId: 'nope' })).rejects.toThrow(/not found/)
    expect(await api.listAllocations()).toEqual([])
  })

  it('logs a change message for every allocation field', async () => {
    const { api, adapter, rent } = await makeApi()
    await api.allocate({ month: '2026-01', categoryId: rent.id, amount: 100 })
    const rows = await adapter.query(
      `SELECT column_name FROM messages WHERE table_name = 'allocations' ORDER BY timestamp`,
    )
    expect(rows.map((r) => r.column_name)).toEqual(
      expect.arrayContaining(['month', 'category_id', 'amount', 'source']),
    )
  })
})

describe('month balances', () => {
  it('lists every category in display order, zeroed when untouched', async () => {
    const { api, rent, food } = await makeApi()
    expect(await api.getMonthBalances('2026-01')).toEqual([
      { categoryId: rent.id, assigned: 0, activity: 0, available: 0 },
      { categoryId: food.id, assigned: 0, activity: 0, available: 0 },
    ])
    await expect(api.getMonthBalances('January')).rejects.toThrow(/month/)
  })

  it('available = assigned + activity, spending reduces it', async () => {
    const { api, food, checking, spend } = await makeApi()
    await api.allocate({ month: '2026-01', categoryId: food.id, amount: 50000 })
    await spend(checking.id, '2026-01-31', food.id, -12345)
    await spend(checking.id, '2026-01-02', food.id, 345) // refund
    expect(balance(await api.getMonthBalances('2026-01'), food.id)).toEqual({
      categoryId: food.id,
      assigned: 50000,
      activity: -12000,
      available: 38000,
    })
  })

  it('carries the balance forward but reports each month’s own assigned and activity', async () => {
    const { api, food, checking, spend } = await makeApi()
    await api.allocate({ month: '2026-01', categoryId: food.id, amount: 50000 })
    await spend(checking.id, '2026-01-15', food.id, -20000)
    await api.allocate({ month: '2026-02', categoryId: food.id, amount: 10000 })
    await spend(checking.id, '2026-02-01', food.id, -5000)
    await spend(checking.id, '2026-03-01', food.id, -1000)

    const jan = balance(await api.getMonthBalances('2026-01'), food.id)
    const feb = balance(await api.getMonthBalances('2026-02'), food.id)
    const dec = balance(await api.getMonthBalances('2025-12'), food.id)
    expect(jan).toMatchObject({ assigned: 50000, activity: -20000, available: 30000 })
    expect(feb).toMatchObject({ assigned: 10000, activity: -5000, available: 35000 })
    expect(dec).toMatchObject({ assigned: 0, activity: 0, available: 0 })
  })

  it('ignores tracking accounts and uncategorized splits', async () => {
    const { api, food, checking, spend, adapter } = await makeApi()
    const brokerage = await api.createAccount({ name: 'Brokerage', type: 'investment' })
    await spend(brokerage.id, '2026-01-10', food.id, -999)
    await spend(checking.id, '2026-01-10', null, -777)
    expect(balance(await api.getMonthBalances('2026-01'), food.id)).toMatchObject({
      activity: 0,
      available: 0,
    })
    // taking an account off budget stops its spending from counting
    await spend(checking.id, '2026-01-11', food.id, -100)
    expect(balance(await api.getMonthBalances('2026-01'), food.id)?.activity).toBe(-100)
    await api.updateAccount(checking.id, { onBudget: false })
    expect(balance(await api.getMonthBalances('2026-01'), food.id)?.activity).toBe(0)
    expect(await adapter.query('SELECT 1 FROM transactions')).toHaveLength(3)
  })

  it('splits a transaction across categories', async () => {
    const { api, rent, food, checking, adapter } = await makeApi()
    await adapter.exec(
      `INSERT INTO transactions (id, account_id, date, amount, created_at) VALUES ('t', ?, '2026-01-05', -3000, 'now')`,
      [checking.id],
    )
    for (const [i, [cat, amt]] of [
      [rent.id, -2000],
      [food.id, -1000],
    ].entries()) {
      await adapter.exec(
        'INSERT INTO transaction_splits (id, transaction_id, category_id, amount, created_at) VALUES (?, ?, ?, ?, ?)',
        [`s${i}`, 't', cat as string, amt as number, 'now'],
      )
    }
    const rows = await api.getMonthBalances('2026-01')
    expect(balance(rows, rent.id)?.activity).toBe(-2000)
    expect(balance(rows, food.id)?.activity).toBe(-1000)
  })

  it('overspending shows as a negative available', async () => {
    const { api, food, checking, spend } = await makeApi()
    await api.allocate({ month: '2026-01', categoryId: food.id, amount: 1000 })
    await spend(checking.id, '2026-01-02', food.id, -1500)
    expect(balance(await api.getMonthBalances('2026-01'), food.id)?.available).toBe(-500)
  })
})

describe('deleting things with history', () => {
  it('refuses to delete a category with allocations or spending, and an account with transactions', async () => {
    const { api, rent, food, checking, spend } = await makeApi()
    await api.allocate({ month: '2026-01', categoryId: rent.id, amount: 100 })
    await expect(api.deleteCategory(rent.id)).rejects.toThrow(/history/)
    await spend(checking.id, '2026-01-02', food.id, -5)
    await expect(api.deleteCategory(food.id)).rejects.toThrow(/history/)
    await expect(api.deleteAccount(checking.id)).rejects.toThrow(/transactions/)
  })
})
