import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { listMessages } from './changes.ts'
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
  const brokerage = await api.createAccount({ name: 'Brokerage', type: 'investment' })
  return { api, adapter, rent, food, checking, brokerage }
}

describe('transactions', () => {
  it('creates a one-split transaction and lists it newest first', async () => {
    const { api, checking, food } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-01-02', amount: 500000 })
    const spent = await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-05',
      payee: '  Kroger ',
      categoryId: food.id,
      amount: -4250,
    })
    expect(spent).toMatchObject({
      payee: 'Kroger',
      amount: -4250,
      cleared: false,
      reconciled: false,
      splits: [{ categoryId: food.id, amount: -4250 }],
    })
    const list = await api.listTransactions({ accountId: checking.id })
    expect(list.map((t) => t.date)).toEqual(['2026-01-05', '2026-01-02'])
    expect(list[1]!.splits).toEqual([expect.objectContaining({ categoryId: null, amount: 500000 })])
  })

  it('filters by account', async () => {
    const { api, checking, brokerage } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-01-02', amount: 100 })
    await api.createTransaction({ accountId: brokerage.id, date: '2026-01-02', amount: 200 })
    expect(await api.listTransactions()).toHaveLength(2)
    expect(await api.listTransactions({ accountId: brokerage.id })).toHaveLength(1)
  })

  it('rejects bad input', async () => {
    const { api, checking } = await makeApi()
    const base = { accountId: checking.id, date: '2026-01-02', amount: 100 }
    await expect(api.createTransaction({ ...base, date: '2026-02-30' })).rejects.toThrow(
      /not a date/,
    )
    await expect(api.createTransaction({ ...base, date: '1/2/26' })).rejects.toThrow(/not a date/)
    await expect(api.createTransaction({ ...base, amount: 0 })).rejects.toThrow(/zero/)
    await expect(api.createTransaction({ ...base, amount: 1.5 })).rejects.toThrow(/whole number/)
    await expect(api.createTransaction({ ...base, accountId: 'nope' })).rejects.toThrow(
      /Account not found/,
    )
    await expect(api.createTransaction({ ...base, categoryId: 'nope' })).rejects.toThrow(
      /Category not found/,
    )
    expect(await api.listTransactions()).toEqual([])
  })

  it('refuses a transaction in a closed account', async () => {
    const { api, checking } = await makeApi()
    await api.updateAccount(checking.id, { closed: true })
    await expect(
      api.createTransaction({ accountId: checking.id, date: '2026-01-02', amount: 100 }),
    ).rejects.toThrow(/closed/)
  })

  it('updates fields and keeps the split in step with the amount and category', async () => {
    const { api, checking, food, rent } = await makeApi()
    const t = await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-02',
      categoryId: food.id,
      amount: -1000,
    })
    const updated = await api.updateTransaction(t.id, {
      payee: 'Landlord',
      categoryId: rent.id,
      amount: -2000,
      cleared: true,
    })
    expect(updated).toMatchObject({
      payee: 'Landlord',
      amount: -2000,
      cleared: true,
      splits: [{ categoryId: rent.id, amount: -2000 }],
    })
    const cleared = await api.updateTransaction(t.id, { categoryId: null })
    expect(cleared.splits[0]!.categoryId).toBeNull()
  })

  it('refuses to change category or amount on a split transaction', async () => {
    const { api, adapter, checking, food } = await makeApi()
    const t = await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-02',
      categoryId: food.id,
      amount: -1000,
    })
    await adapter.exec(
      'INSERT INTO transaction_splits (id, transaction_id, category_id, amount, created_at) VALUES (?, ?, ?, ?, ?)',
      ['extra', t.id, null, 0, 'now'],
    )
    await expect(api.updateTransaction(t.id, { amount: -500 })).rejects.toThrow(/Split/)
    // fields outside the split still work
    expect((await api.updateTransaction(t.id, { cleared: true })).cleared).toBe(true)
  })

  it('locks reconciled transactions', async () => {
    const { api, adapter, checking } = await makeApi()
    const t = await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-02',
      amount: 100,
    })
    await adapter.exec('UPDATE transactions SET reconciled = 1 WHERE id = ?', [t.id])
    await expect(api.updateTransaction(t.id, { payee: 'x' })).rejects.toThrow(/reconciled/)
    await expect(api.deleteTransaction(t.id)).rejects.toThrow(/reconciled/)
  })

  it('deletes a transaction with its splits', async () => {
    const { api, adapter, checking, food } = await makeApi()
    const t = await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-02',
      categoryId: food.id,
      amount: -1000,
    })
    await api.deleteTransaction(t.id)
    expect(await api.listTransactions()).toEqual([])
    expect(await adapter.query('SELECT 1 FROM transaction_splits')).toEqual([])
    await expect(api.deleteTransaction(t.id)).rejects.toThrow(/not found/)
  })

  it('logs a change message for every write', async () => {
    const { api, adapter, checking } = await makeApi()
    const before = (await listMessages(adapter)).length
    const t = await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-02',
      amount: 100,
    })
    await api.updateTransaction(t.id, { cleared: true })
    await api.deleteTransaction(t.id)
    const messages = (await listMessages(adapter)).slice(before)
    expect(messages.some((m) => m.table === 'transactions' && m.column === 'cleared')).toBe(true)
    expect(messages.filter((m) => m.column === '_deleted').map((m) => m.table)).toEqual([
      'transaction_splits',
      'transactions',
    ])
  })

  it('totals each account’s balance and its cleared part', async () => {
    const { api, checking, brokerage } = await makeApi()
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-01',
      amount: 100000,
      cleared: true,
    })
    await api.createTransaction({ accountId: checking.id, date: '2026-01-02', amount: -2500 })
    expect(await api.getAccountBalances()).toEqual([
      { accountId: checking.id, balance: 97500, cleared: 100000 },
      { accountId: brokerage.id, balance: 0, cleared: 0 },
    ])
  })
})

describe('ready to assign', () => {
  it('is zero for an empty budget', async () => {
    const { api } = await makeApi()
    expect(await api.getReadyToAssign()).toBe(0)
  })

  it('counts uncategorized inflows as income and subtracts what is assigned', async () => {
    const { api, checking, rent } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-01-01', amount: 300000 })
    expect(await api.getReadyToAssign()).toBe(300000)
    await api.allocate({ month: '2026-01', categoryId: rent.id, amount: 120000 })
    expect(await api.getReadyToAssign()).toBe(180000)
  })

  it('does not change when money is spent from an envelope that holds it', async () => {
    const { api, checking, rent } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-01-01', amount: 300000 })
    await api.allocate({ month: '2026-01', categoryId: rent.id, amount: 120000 })
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-03',
      categoryId: rent.id,
      amount: -120000,
    })
    expect(await api.getReadyToAssign()).toBe(180000)
  })

  it('lets cash overspending lower it', async () => {
    const { api, checking, food } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-01-01', amount: 300000 })
    await api.allocate({ month: '2026-01', categoryId: food.id, amount: 10000 })
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-03',
      categoryId: food.id,
      amount: -15000,
    })
    // food is 50.00 overspent: the 100.00 it held is gone and 50.00 more left the account
    expect(await api.getReadyToAssign()).toBe(300000 - 15000)
  })

  it('ignores tracking accounts', async () => {
    const { api, brokerage } = await makeApi()
    await api.createTransaction({ accountId: brokerage.id, date: '2026-01-01', amount: 900000 })
    expect(await api.getReadyToAssign()).toBe(0)
  })
})
