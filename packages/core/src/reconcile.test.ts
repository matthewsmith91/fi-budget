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
    now: () => '2026-02-01T12:00:00.000Z',
  })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  const savings = await api.createAccount({ name: 'Savings', type: 'savings' })
  const enter = (accountId: string, date: string, amount: number, cleared: boolean) =>
    api.createTransaction({ accountId, date, amount, cleared })
  return { api, checking, savings, enter }
}

describe('reconciliation', () => {
  it('reports cleared and reconciled balances', async () => {
    const { api, checking, enter } = await makeApi()
    await enter(checking.id, '2026-01-02', 100000, true)
    await enter(checking.id, '2026-01-05', -2500, true)
    await enter(checking.id, '2026-01-06', -900, false)
    expect(await api.getReconciliation(checking.id)).toEqual({
      accountId: checking.id,
      clearedBalance: 97500,
      reconciledBalance: 0,
      toReconcile: 2,
      lastReconciledDate: null,
    })
    await expect(api.getReconciliation('nope')).rejects.toThrow(/Account not found/)
  })

  it('locks the cleared transactions when the balance matches, with no adjustment', async () => {
    const { api, checking, enter } = await makeApi()
    const a = await enter(checking.id, '2026-01-02', 100000, true)
    const b = await enter(checking.id, '2026-01-05', -2500, true)
    const open = await enter(checking.id, '2026-01-06', -900, false)
    const result = await api.reconcileAccount({ accountId: checking.id, statementBalance: 97500 })
    expect(result).toEqual({ adjustment: null, reconciled: 2 })
    const byId = new Map((await api.listTransactions()).map((t) => [t.id, t]))
    expect(byId.get(a.id)!.reconciled).toBe(true)
    expect(byId.get(b.id)!.reconciled).toBe(true)
    expect(byId.get(open.id)!.reconciled).toBe(false)
    expect(await api.getReconciliation(checking.id)).toMatchObject({
      clearedBalance: 97500,
      reconciledBalance: 97500,
      toReconcile: 0,
      lastReconciledDate: '2026-01-05',
    })
  })

  it('posts a cleared, uncategorized adjustment for the difference and locks it too', async () => {
    const { api, checking, enter } = await makeApi()
    await enter(checking.id, '2026-01-02', 100000, true)
    const result = await api.reconcileAccount({
      accountId: checking.id,
      statementBalance: 99000,
      date: '2026-01-31',
    })
    expect(result.reconciled).toBe(2)
    expect(result.adjustment).toMatchObject({
      accountId: checking.id,
      date: '2026-01-31',
      payee: 'Reconciliation Balance Adjustment',
      amount: -1000,
      cleared: true,
      reconciled: true,
      splits: [{ categoryId: null, amount: -1000 }],
    })
    const [balance] = await api.getAccountBalances()
    expect(balance).toMatchObject({ balance: 99000, cleared: 99000 })
  })

  it('defaults the adjustment to today', async () => {
    const { api, checking, enter } = await makeApi()
    await enter(checking.id, '2026-01-02', 100, true)
    const { adjustment } = await api.reconcileAccount({
      accountId: checking.id,
      statementBalance: 150,
    })
    expect(adjustment).toMatchObject({ date: '2026-02-01', amount: 50 })
  })

  it('a positive difference counts as income for the budget', async () => {
    const { api, checking, enter } = await makeApi()
    await enter(checking.id, '2026-01-02', 100000, true)
    await api.reconcileAccount({ accountId: checking.id, statementBalance: 101000 })
    // dated today (February), so January is unchanged
    expect(await api.getReadyToAssign('2026-01')).toBe(100000)
    expect(await api.getReadyToAssign('2026-02')).toBe(101000)
  })

  it('works on an empty account and on later passes', async () => {
    const { api, checking, enter } = await makeApi()
    expect(await api.reconcileAccount({ accountId: checking.id, statementBalance: 0 })).toEqual({
      adjustment: null,
      reconciled: 0,
    })
    await enter(checking.id, '2026-01-02', 5000, true)
    await api.reconcileAccount({ accountId: checking.id, statementBalance: 5000 })
    await enter(checking.id, '2026-02-02', -1000, true)
    const second = await api.reconcileAccount({ accountId: checking.id, statementBalance: 4000 })
    // only the new transaction is locked this time
    expect(second).toEqual({ adjustment: null, reconciled: 1 })
  })

  it('locks reconciled transactions against edits and deletion', async () => {
    const { api, checking, enter } = await makeApi()
    const t = await enter(checking.id, '2026-01-02', 5000, true)
    await api.reconcileAccount({ accountId: checking.id, statementBalance: 5000 })
    await expect(api.updateTransaction(t.id, { amount: 6000 })).rejects.toThrow(/reconciled/)
    await expect(api.deleteTransaction(t.id)).rejects.toThrow(/reconciled/)
  })

  it('leaves other accounts alone', async () => {
    const { api, checking, savings, enter } = await makeApi()
    await enter(checking.id, '2026-01-02', 5000, true)
    const other = await enter(savings.id, '2026-01-02', 7000, true)
    await api.reconcileAccount({ accountId: checking.id, statementBalance: 5000 })
    expect((await api.listTransactions({ accountId: savings.id }))[0]).toMatchObject({
      id: other.id,
      reconciled: false,
    })
  })

  it('rejects bad input without writing anything', async () => {
    const { api, checking, enter } = await makeApi()
    await enter(checking.id, '2026-01-02', 5000, true)
    await expect(
      api.reconcileAccount({ accountId: checking.id, statementBalance: 10.5 }),
    ).rejects.toThrow(/whole number/)
    await expect(
      api.reconcileAccount({ accountId: checking.id, statementBalance: 1, date: 'x' }),
    ).rejects.toThrow(/not a date/)
    await expect(api.reconcileAccount({ accountId: 'nope', statementBalance: 0 })).rejects.toThrow(
      /Account not found/,
    )
    expect(await api.listTransactions()).toHaveLength(1)
    expect((await api.listTransactions())[0]!.reconciled).toBe(false)
  })
})
