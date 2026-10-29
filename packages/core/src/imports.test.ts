import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import type { ImportAccount } from './imports.ts'
import { openMemoryAdapter } from './test-utils.ts'

async function makeApi() {
  const adapter = await openMemoryAdapter()
  let n = 0
  const api = createBudgetApi({
    adapter,
    storage: 'memory',
    sqliteVersion: 'test',
    newId: () => `id-${++n}`,
    now: () => '2026-10-28T00:00:00.000Z',
  })
  const group = await api.createCategoryGroup({ name: 'Bills' })
  const food = await api.createCategory({ groupId: group.id, name: 'Food' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  const savings = await api.createAccount({ name: 'Savings', type: 'savings' })
  await api.mapExternalAccount({
    externalId: 'ACT-1',
    name: 'Chase Checking',
    accountId: checking.id,
  })
  return { api, adapter, food, checking, savings }
}

const bank = (
  ...transactions: { id: string; posted: string; amount: number; description?: string }[]
): ImportAccount[] => [
  {
    id: 'ACT-1',
    name: 'Chase Checking',
    transactions: transactions.map((t) => ({ description: '', ...t })),
  },
]

describe('mapping bank accounts', () => {
  it('links, relinks and unlinks a bank account', async () => {
    const { api, checking, savings } = await makeApi()
    expect(await api.listAccountMappings()).toEqual([
      { externalId: 'ACT-1', name: 'Chase Checking', org: '', accountId: checking.id },
    ])
    await api.mapExternalAccount({ externalId: 'ACT-1', name: 'Chase', accountId: savings.id })
    expect((await api.listAccountMappings())[0]).toMatchObject({
      name: 'Chase',
      accountId: savings.id,
    })
    await api.mapExternalAccount({ externalId: 'ACT-1', name: 'Chase', accountId: null })
    expect((await api.listAccountMappings())[0]!.accountId).toBeNull()
  })

  it('gives one app account only one bank account', async () => {
    const { api, checking } = await makeApi()
    await expect(
      api.mapExternalAccount({ externalId: 'ACT-2', name: 'Other', accountId: checking.id }),
    ).rejects.toThrow(/Already linked to the bank account “Chase Checking”/)
  })

  it('refuses a missing or closed account', async () => {
    const { api, savings } = await makeApi()
    await expect(
      api.mapExternalAccount({ externalId: 'ACT-2', name: 'x', accountId: 'nope' }),
    ).rejects.toThrow(/not found/)
    await api.updateAccount(savings.id, { closed: true })
    await expect(
      api.mapExternalAccount({ externalId: 'ACT-2', name: 'x', accountId: savings.id }),
    ).rejects.toThrow(/closed/)
  })
})

describe('importing transactions', () => {
  it('adds new transactions to the inbox, cleared and uncategorized', async () => {
    const { api, checking } = await makeApi()
    const summary = await api.importTransactions(
      bank({ id: 'T1', posted: '2026-10-20', amount: -4_250, description: ' KROGER #123 ' }),
    )
    expect(summary).toMatchObject({ added: 1, matched: 0, alreadyImported: 0, unmapped: [] })
    const [t] = await api.listTransactions({ unapproved: true })
    expect(t).toMatchObject({
      accountId: checking.id,
      date: '2026-10-20',
      payee: 'KROGER #123',
      amount: -4_250,
      cleared: true,
      approved: false,
      importId: 'ACT-1:T1',
      splits: [{ categoryId: null, amount: -4_250 }],
    })
    expect((await api.getAccountBalances()).find((b) => b.accountId === checking.id)).toMatchObject(
      { balance: -4_250, cleared: -4_250 },
    )
  })

  it('does nothing the second time it sees the same transactions', async () => {
    const { api } = await makeApi()
    const data = bank({ id: 'T1', posted: '2026-10-20', amount: -100 })
    await api.importTransactions(data)
    const again = await api.importTransactions(data)
    expect(again).toMatchObject({ added: 0, alreadyImported: 1 })
    expect(await api.listTransactions()).toHaveLength(1)
  })

  it('keeps an approved transaction approved when it is seen again', async () => {
    const { api } = await makeApi()
    const data = bank({ id: 'T1', posted: '2026-10-20', amount: -100 })
    await api.importTransactions(data)
    const [t] = await api.listTransactions()
    await api.approveTransactions([t!.id])
    await api.importTransactions(data)
    expect(await api.listTransactions({ unapproved: true })).toEqual([])
  })

  it('does not bring back a transaction that was deleted from the inbox', async () => {
    const { api } = await makeApi()
    const data = bank({ id: 'T1', posted: '2026-10-20', amount: -100 })
    await api.importTransactions(data)
    const [t] = await api.listTransactions()
    await api.deleteTransaction(t!.id)
    const again = await api.importTransactions(data)
    expect(again).toMatchObject({ added: 0, dismissed: 1 })
    expect(await api.listTransactions()).toEqual([])
  })

  it('reports bank accounts that have nowhere to go', async () => {
    const { api } = await makeApi()
    const summary = await api.importTransactions([
      {
        id: 'ACT-9',
        name: 'Mystery',
        transactions: [{ id: 'X', posted: '2026-10-20', amount: -5, description: '' }],
      },
      { id: 'ACT-8', name: 'Quiet', transactions: [] },
    ])
    expect(summary.unmapped).toEqual([{ externalId: 'ACT-9', name: 'Mystery', transactions: 1 }])
    expect(await api.listTransactions()).toEqual([])
  })

  it('leaves a bank account alone once it is unlinked or its account closed', async () => {
    const { api, checking } = await makeApi()
    await api.mapExternalAccount({ externalId: 'ACT-1', name: 'x', accountId: null })
    let summary = await api.importTransactions(bank({ id: 'T1', posted: '2026-10-20', amount: -1 }))
    expect(summary).toMatchObject({ added: 0, unmapped: [expect.anything()] })
    await api.mapExternalAccount({ externalId: 'ACT-1', name: 'x', accountId: checking.id })
    await api.updateAccount(checking.id, { closed: true })
    summary = await api.importTransactions(bank({ id: 'T1', posted: '2026-10-20', amount: -1 }))
    expect(summary).toMatchObject({ added: 0, unmapped: [expect.anything()] })
  })

  it('skips zero amounts and rejects fractional cents', async () => {
    const { api } = await makeApi()
    await api.importTransactions(bank({ id: 'Z', posted: '2026-10-20', amount: 0 }))
    expect(await api.listTransactions()).toEqual([])
    await expect(
      api.importTransactions(bank({ id: 'F', posted: '2026-10-20', amount: -1.5 })),
    ).rejects.toThrow(/whole number of cents/)
  })

  it('imports nothing at all if one transaction is bad', async () => {
    const { api } = await makeApi()
    await expect(
      api.importTransactions(
        bank(
          { id: 'A', posted: '2026-10-20', amount: -100 },
          { id: 'B', posted: 'not a date', amount: -100 },
        ),
      ),
    ).rejects.toThrow(/not a date/)
    expect(await api.listTransactions()).toEqual([])
  })
})

describe('de-duplicating against manual entries', () => {
  it('folds a bank transaction into the manual entry with the same amount and nearby date', async () => {
    const { api, checking, food } = await makeApi()
    const manual = await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-18',
      payee: 'Kroger',
      categoryId: food.id,
      amount: -4_250,
    })
    const summary = await api.importTransactions(
      bank({ id: 'T1', posted: '2026-10-20', amount: -4_250, description: 'KROGER #123' }),
    )
    expect(summary).toMatchObject({ added: 0, matched: 1 })
    const all = await api.listTransactions()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      id: manual.id,
      payee: 'Kroger',
      date: '2026-10-18',
      cleared: true,
      approved: true,
      importId: 'ACT-1:T1',
      splits: [{ categoryId: food.id }],
    })
    // and the bank transaction is not matched a second time
    expect(
      await api.importTransactions(bank({ id: 'T1', posted: '2026-10-20', amount: -4_250 })),
    ).toMatchObject({ alreadyImported: 1, matched: 0 })
  })

  it('does not match across amounts, accounts or more than three days', async () => {
    const { api, checking, savings } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-10-10', amount: -4_250 })
    await api.createTransaction({ accountId: checking.id, date: '2026-10-20', amount: -4_251 })
    await api.createTransaction({ accountId: savings.id, date: '2026-10-20', amount: -4_250 })
    const summary = await api.importTransactions(
      bank({ id: 'T1', posted: '2026-10-20', amount: -4_250 }),
    )
    expect(summary).toMatchObject({ added: 1, matched: 0 })
  })

  it('matches on the edge of the window', async () => {
    const { api, checking } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-10-17', amount: -100 })
    expect(
      await api.importTransactions(bank({ id: 'T1', posted: '2026-10-20', amount: -100 })),
    ).toMatchObject({ matched: 1 })
  })

  it('pairs two bank transactions with two manual ones, one each', async () => {
    const { api, checking } = await makeApi()
    const first = await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-19',
      payee: 'Coffee',
      amount: -500,
    })
    const second = await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-21',
      payee: 'Coffee',
      amount: -500,
    })
    const summary = await api.importTransactions(
      bank(
        { id: 'A', posted: '2026-10-19', amount: -500 },
        { id: 'B', posted: '2026-10-21', amount: -500 },
        { id: 'C', posted: '2026-10-21', amount: -500 },
      ),
    )
    expect(summary).toMatchObject({ matched: 2, added: 1 })
    const byId = new Map((await api.listTransactions()).map((t) => [t.id, t]))
    expect(byId.get(first.id)!.importId).toBe('ACT-1:A')
    expect(byId.get(second.id)!.importId).toBe('ACT-1:B')
  })

  it('prefers the closest date, then the better payee', async () => {
    const { api, checking } = await makeApi()
    const far = await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-18',
      payee: 'Costco',
      amount: -9_000,
    })
    const near = await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-20',
      payee: 'Other',
      amount: -9_000,
    })
    await api.importTransactions(
      bank({ id: 'T1', posted: '2026-10-20', amount: -9_000, description: 'COSTCO WHSE' }),
    )
    const byId = new Map((await api.listTransactions()).map((t) => [t.id, t]))
    expect(byId.get(near.id)!.importId).toBe('ACT-1:T1')
    expect(byId.get(far.id)!.importId).toBeNull()

    const a = await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-25',
      payee: 'Shell',
      amount: -3_000,
    })
    const b = await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-25',
      payee: 'Costco',
      amount: -3_000,
    })
    await api.importTransactions(
      bank({ id: 'T2', posted: '2026-10-25', amount: -3_000, description: 'COSTCO GAS' }),
    )
    const after = new Map((await api.listTransactions()).map((t) => [t.id, t]))
    expect(after.get(b.id)!.importId).toBe('ACT-1:T2')
    expect(after.get(a.id)!.importId).toBeNull()
  })

  it('leaves reconciled entries, transfers and unapproved imports alone', async () => {
    const { api, checking, savings } = await makeApi()
    const locked = await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-20',
      amount: -700,
      cleared: true,
    })
    await api.reconcileAccount({ accountId: checking.id, statementBalance: -700 })
    expect((await api.listTransactions()).find((t) => t.id === locked.id)!.reconciled).toBe(true)
    await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-10-20',
      amount: 800,
    })
    await api.importTransactions(bank({ id: 'A', posted: '2026-10-20', amount: -700 }))
    await api.importTransactions(bank({ id: 'B', posted: '2026-10-20', amount: -800 }))
    const unapproved = await api.listTransactions({ unapproved: true })
    expect(unapproved.map((t) => t.importId).sort()).toEqual(['ACT-1:A', 'ACT-1:B'])
  })
})

describe('the inbox', () => {
  it('lists unapproved transactions, oldest first, and approves them', async () => {
    const { api, food } = await makeApi()
    await api.importTransactions(
      bank(
        { id: 'B', posted: '2026-10-22', amount: -200 },
        { id: 'A', posted: '2026-10-21', amount: -100 },
      ),
    )
    const inbox = await api.listInbox()
    expect(inbox.map((i) => i.transaction.importId)).toEqual(['ACT-1:A', 'ACT-1:B'])
    await api.updateTransaction(inbox[0]!.transaction.id, { categoryId: food.id })
    await api.approveTransactions([inbox[0]!.transaction.id])
    expect((await api.listInbox()).map((i) => i.transaction.importId)).toEqual(['ACT-1:B'])
    expect((await api.listTransactions()).find((t) => t.importId === 'ACT-1:A')).toMatchObject({
      approved: true,
      splits: [{ categoryId: food.id }],
    })
    await expect(api.approveTransactions(['nope'])).rejects.toThrow(/not found/)
  })

  it('offers manual entries as possible duplicates and merges one in', async () => {
    const { api, checking, food } = await makeApi()
    await api.importTransactions(
      bank({ id: 'T1', posted: '2026-10-20', amount: -4_250, description: 'KROGER' }),
    )
    // entered by hand after the import arrived
    const manual = await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-20',
      payee: 'Kroger',
      categoryId: food.id,
      amount: -4_250,
    })
    const [item] = await api.listInbox()
    expect(item!.possibleDuplicates.map((t) => t.id)).toEqual([manual.id])

    const merged = await api.mergeImport(item!.transaction.id, manual.id)
    expect(merged).toMatchObject({
      id: manual.id,
      importId: 'ACT-1:T1',
      cleared: true,
      approved: true,
      payee: 'Kroger',
    })
    expect(await api.listTransactions()).toHaveLength(1)
    expect(await api.listInbox()).toEqual([])
    // the merged bank transaction is not imported again
    expect(
      await api.importTransactions(bank({ id: 'T1', posted: '2026-10-20', amount: -4_250 })),
    ).toMatchObject({ added: 0, alreadyImported: 1 })
  })

  it('refuses to merge things that are not the same purchase', async () => {
    const { api, checking } = await makeApi()
    await api.importTransactions(bank({ id: 'T1', posted: '2026-10-20', amount: -100 }))
    const other = await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-20',
      amount: -101,
    })
    const [item] = await api.listInbox()
    await expect(api.mergeImport(item!.transaction.id, other.id)).rejects.toThrow(/not the same/)
    await expect(api.mergeImport(other.id, other.id)).rejects.toThrow(/not waiting/)
  })

  it('remembers a deleted manual entry that had been matched to the bank', async () => {
    const { api, checking } = await makeApi()
    const manual = await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-20',
      amount: -100,
    })
    const data = bank({ id: 'T1', posted: '2026-10-20', amount: -100 })
    await api.importTransactions(data)
    await api.deleteTransaction(manual.id)
    expect(await api.importTransactions(data)).toMatchObject({ added: 0, dismissed: 1 })
  })
})
