import { describe, expect, it } from 'vitest'
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
  const food = await api.createCategory({ groupId: group.id, name: 'Food' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  const savings = await api.createAccount({ name: 'Savings', type: 'savings' })
  const brokerage = await api.createAccount({ name: 'Brokerage', type: 'investment' })
  return { api, adapter, food, checking, savings, brokerage }
}

describe('transfers', () => {
  it('creates a pair of mirrored transactions that point at each other', async () => {
    const { api, checking, savings } = await makeApi()
    const [out, into] = await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-01-10',
      amount: 25000,
    })
    expect(out).toMatchObject({
      accountId: checking.id,
      amount: -25000,
      transferAccountId: savings.id,
      splits: [{ categoryId: null, amount: -25000 }],
    })
    expect(into).toMatchObject({
      accountId: savings.id,
      amount: 25000,
      transferAccountId: checking.id,
      splits: [{ categoryId: null, amount: 25000 }],
    })
    expect(out.transferPairId).not.toBeNull()
    expect(out.transferPairId).toBe(into.transferPairId)
    const balances = await api.getAccountBalances()
    expect(balances.map((b) => b.balance)).toEqual([-25000, 25000, 0])
  })

  it('leaves Ready to Assign alone when both accounts are on budget', async () => {
    const { api, checking, savings } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-01-02', amount: 100000 })
    await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-01-10',
      amount: 25000,
    })
    expect(await api.getReadyToAssign('2026-01')).toBe(100000)
  })

  it('treats a move into a tracking account as spending out of the budget', async () => {
    const { api, checking, brokerage, food } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-01-02', amount: 100000 })
    await api.allocate({ month: '2026-01', categoryId: food.id, amount: 40000 })
    const [out, into] = await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: brokerage.id,
      date: '2026-01-10',
      amount: 30000,
      categoryId: food.id,
    })
    expect(out.splits[0]!.categoryId).toBe(food.id)
    expect(into.splits[0]!.categoryId).toBeNull()
    const [row] = (await api.getMonthBalances('2026-01')).filter((b) => b.categoryId === food.id)
    expect(row).toMatchObject({ activity: -30000, available: 10000 })
    // the tracking leg is outside the budget, so it neither adds to nor takes from Ready to Assign
    expect(await api.getReadyToAssign('2026-01')).toBe(60000)
  })

  it('refuses a category unless exactly one side is a tracking account', async () => {
    const { api, checking, savings, food } = await makeApi()
    await expect(
      api.createTransfer({
        fromAccountId: checking.id,
        toAccountId: savings.id,
        date: '2026-01-10',
        amount: 100,
        categoryId: food.id,
      }),
    ).rejects.toThrow(/tracking account/)
  })

  it('rejects bad input without writing anything', async () => {
    const { api, checking, savings } = await makeApi()
    const base = {
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-01-10',
      amount: 100,
    }
    await expect(api.createTransfer({ ...base, toAccountId: checking.id })).rejects.toThrow(
      /different accounts/,
    )
    await expect(api.createTransfer({ ...base, amount: -100 })).rejects.toThrow(/positive/)
    await expect(api.createTransfer({ ...base, amount: 0 })).rejects.toThrow(/zero/)
    await expect(api.createTransfer({ ...base, amount: 1.5 })).rejects.toThrow(/whole number/)
    await expect(api.createTransfer({ ...base, date: 'soon' })).rejects.toThrow(/not a date/)
    await expect(api.createTransfer({ ...base, toAccountId: 'nope' })).rejects.toThrow(
      /Account not found/,
    )
    await api.updateAccount(savings.id, { closed: true })
    await expect(api.createTransfer(base)).rejects.toThrow(/closed/)
    expect(await api.listTransactions()).toEqual([])
  })

  it('mirrors an amount edit onto the other leg and keeps each leg’s own date and cleared flag', async () => {
    const { api, checking, savings } = await makeApi()
    const [out, into] = await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-01-10',
      amount: 25000,
    })
    const edited = await api.updateTransaction(into.id, {
      amount: 30000,
      date: '2026-01-12',
      cleared: true,
    })
    expect(edited).toMatchObject({ amount: 30000, date: '2026-01-12', cleared: true })
    expect(edited.splits[0]!.amount).toBe(30000)
    const other = (await api.listTransactions({ accountId: checking.id }))[0]!
    expect(other).toMatchObject({ id: out.id, amount: -30000, date: '2026-01-10', cleared: false })
    expect(other.splits[0]!.amount).toBe(-30000)
  })

  it('refuses edits that would break the pair', async () => {
    const { api, checking, savings, food } = await makeApi()
    const [out] = await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-01-10',
      amount: 25000,
    })
    await expect(api.updateTransaction(out.id, { payee: 'Ally' })).rejects.toThrow(/no payee/)
    await expect(
      api.updateTransaction(out.id, { splits: [{ categoryId: null, amount: -25000 }] }),
    ).rejects.toThrow(/split/)
    await expect(api.updateTransaction(out.id, { amount: 100 })).rejects.toThrow(/direction/)
    await expect(api.updateTransaction(out.id, { categoryId: food.id })).rejects.toThrow(
      /tracking account/,
    )
  })

  it('lets the budget leg of a tracking transfer change category', async () => {
    const { api, checking, brokerage, food } = await makeApi()
    const [out] = await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: brokerage.id,
      date: '2026-01-10',
      amount: 10000,
    })
    const edited = await api.updateTransaction(out.id, { categoryId: food.id })
    expect(edited.splits[0]!.categoryId).toBe(food.id)
  })

  it('deletes both legs together', async () => {
    const { api, adapter, checking, savings } = await makeApi()
    const [out] = await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-01-10',
      amount: 25000,
    })
    await api.deleteTransaction(out.id)
    expect(await api.listTransactions()).toEqual([])
    const [{ n }] = await adapter.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transaction_splits',
    )
    expect(n).toBe(0)
  })

  it('refuses to touch a transfer whose other leg is reconciled', async () => {
    const { api, adapter, checking, savings } = await makeApi()
    const [out, into] = await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-01-10',
      amount: 25000,
    })
    await adapter.exec('UPDATE transactions SET reconciled = 1 WHERE id = ?', [into.id])
    await expect(api.deleteTransaction(out.id)).rejects.toThrow(/reconciled/)
    await expect(api.updateTransaction(out.id, { amount: -100 })).rejects.toThrow(/reconciled/)
    // a date change touches only this leg
    expect((await api.updateTransaction(out.id, { date: '2026-01-11' })).date).toBe('2026-01-11')
  })

  it('logs every change of a transfer as messages', async () => {
    const { api, adapter, checking, savings } = await makeApi()
    await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-01-10',
      amount: 25000,
    })
    const rows = await adapter.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM messages WHERE column_name = 'transfer_pair_id' OR table_name = 'transaction_splits'`,
    )
    expect(rows.map((r) => r.table_name).sort()).toEqual(['transaction_splits', 'transactions'])
  })
})
