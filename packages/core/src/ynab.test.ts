import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { openMemoryAdapter } from './test-utils.ts'

const REGISTER = [
  'Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared',
  'Checking,,09/01/2026,Starting Balance,Inflow: Ready to Assign,Inflow,Ready to Assign,,$0.00,"$5,000.00",Reconciled',
  'Checking,,10/01/2026,Employer,Inflow: Ready to Assign,Inflow,Ready to Assign,,$0.00,"$3,000.00",Cleared',
  'Checking,,10/15/2026,Kroger,Everyday: Groceries,Everyday,Groceries,weekly shop,$120.50,$0.00,Cleared',
  'Visa,,10/05/2026,"Shell, Inc.",Auto: Fuel,Auto,Fuel,,$40.00,$0.00,Uncleared',
  'Checking,,10/10/2026,Transfer : Visa,,,,,$40.00,$0.00,Cleared',
  'Visa,,10/10/2026,Transfer : Checking,,,,,$0.00,$40.00,Uncleared',
  'Checking,,10/12/2026,Costco,Everyday: Groceries,Everyday,Groceries,(Split 1/2) bulk,$60.00,$0.00,Cleared',
  'Checking,,10/12/2026,Costco,Everyday: Household,Everyday,Household,(Split 2/2) paper,$40.00,$0.00,Cleared',
  'Checking,,10/20/2026,Transfer : Brokerage,Savings: Retirement,Savings,Retirement,,$200.00,$0.00,Cleared',
  'Brokerage,,10/20/2026,Transfer : Checking,,,,,$0.00,$200.00,Cleared',
  'Checking,,10/21/2026,Transfer : Old Account,,,,,$10.00,$0.00,Uncleared',
  'Checking,,10/22/2026,Nothing,,,,,$0.00,$0.00,Uncleared',
].join('\n')

const BUDGET = [
  'Month,Category Group/Category,Category Group,Category,Budgeted,Activity,Available',
  'September 2026,Everyday: Groceries,Everyday,Groceries,$0.00,$0.00,$0.00',
  'October 2026,Everyday: Groceries,Everyday,Groceries,$400.00,-$180.50,$219.50',
  'October 2026,Everyday: Household,Everyday,Household,$100.00,-$40.00,$60.00',
  'October 2026,Auto: Fuel,Auto,Fuel,$50.00,-$40.00,$10.00',
  'October 2026,Savings: Retirement,Savings,Retirement,$200.00,-$200.00,$0.00',
  'October 2026,Credit Card Payments: Visa,Credit Card Payments,Visa,$0.00,$40.00,$40.00',
].join('\n')

const CHOICES = {
  Checking: { create: { type: 'checking', onBudget: true } },
  Visa: { create: { type: 'credit', onBudget: true } },
  Brokerage: { create: { type: 'investment', onBudget: false } },
} as const

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
  return { api, adapter }
}

const input = (
  extra: Partial<Parameters<Awaited<ReturnType<typeof makeApi>>['api']['importYnab']>[0]> = {},
) => ({
  register: REGISTER,
  budget: BUDGET,
  accounts: { ...CHOICES },
  ...extra,
})

describe('previewYnabImport', () => {
  it('describes the files without changing anything', async () => {
    const { api } = await makeApi()
    const p = await api.previewYnabImport({ register: REGISTER, budget: BUDGET })
    expect(p).toMatchObject({
      dateOrder: 'MDY',
      ambiguousDates: false,
      transactions: 6,
      splitTransactions: 1,
      transfers: 2,
      categories: 4,
      newCategories: 4,
      allocations: 4,
      months: 1,
      first: '2026-09-01',
      last: '2026-10-21',
    })
    expect(p.accounts.map((a) => [a.name, a.transactions, a.balance, a.match])).toEqual([
      ['Checking', 7, 752950, null],
      ['Visa', 2, 0, null],
      ['Brokerage', 1, 20000, null],
    ])
    // Only Brokerage has no line YNAB put in the budget.
    expect(p.accounts.map((a) => [a.name, a.tracking])).toEqual([
      ['Checking', false],
      ['Visa', false],
      ['Brokerage', true],
    ])
    expect(p.warnings.join(' ')).toMatch(/Memos are not imported/)
    expect(p.warnings.join(' ')).toMatch(/1 transfer has no matching/)
    expect(p.warnings.join(' ')).toMatch(/1 line with no amount/)
    expect(await api.listTransactions()).toEqual([])
    expect(await api.listAccounts()).toEqual([])
  })

  it('finds accounts that already exist by name', async () => {
    const { api } = await makeApi()
    const checking = await api.createAccount({ name: 'checking', type: 'checking' })
    const p = await api.previewYnabImport({ register: REGISTER })
    expect(p.accounts[0]!.match).toEqual({
      accountId: checking.id,
      closed: false,
      hasTransactions: false,
    })
    expect(p.warnings.join(' ')).toMatch(/Without Budget\.csv/)
  })
})

describe('importYnab', () => {
  it('brings in accounts, transactions, splits, transfers and assignments', async () => {
    const { api } = await makeApi()
    const result = await api.importYnab(input())
    expect(result).toMatchObject({
      accountsCreated: 3,
      transactions: 6,
      splitTransactions: 1,
      transfers: 2,
      groupsCreated: 3,
      categoriesCreated: 4,
      allocations: 4,
    })

    const accounts = await api.listAccounts()
    expect(accounts.map((a) => [a.name, a.type, a.onBudget])).toEqual([
      ['Checking', 'checking', true],
      ['Visa', 'credit', true],
      ['Brokerage', 'investment', false],
    ])
    const balances = Object.fromEntries(
      (await api.getAccountBalances()).map((b) => [
        accounts.find((a) => a.id === b.accountId)!.name,
        b,
      ]),
    )
    expect(balances.Checking).toMatchObject({ balance: 752950 })
    expect(balances.Visa).toMatchObject({ balance: 0 })
    expect(balances.Brokerage).toMatchObject({ balance: 20000 })
  })

  it('keeps cleared state and locks reconciled transactions', async () => {
    const { api } = await makeApi()
    await api.importYnab(input())
    const all = await api.listTransactions()
    const start = all.find((t) => t.payee === 'Starting Balance')!
    expect(start).toMatchObject({ cleared: true, reconciled: true, approved: true, amount: 500000 })
    const shell = all.find((t) => t.payee === 'Shell, Inc.')!
    expect(shell).toMatchObject({ cleared: false, reconciled: false, amount: -4000 })
    await expect(api.updateTransaction(start.id, { cleared: false })).rejects.toThrow(/locked/)
  })

  it('imports a split as one transaction with a line per category', async () => {
    const { api } = await makeApi()
    await api.importYnab(input())
    const groups = await api.listCategoryGroups()
    const name = (id: string | null) =>
      groups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? null
    const costco = (await api.listTransactions()).find((t) => t.payee === 'Costco')!
    expect(costco.amount).toBe(-10000)
    expect(costco.splits.map((s) => [name(s.categoryId), s.amount])).toEqual([
      ['Groceries', -6000],
      ['Household', -4000],
    ])
  })

  it('pairs transfers, keeping a category only on the budget side of a budget-to-tracking one', async () => {
    const { api } = await makeApi()
    await api.importYnab(input())
    const accounts = await api.listAccounts()
    const id = (n: string) => accounts.find((a) => a.name === n)!.id
    const all = await api.listTransactions()
    const groups = await api.listCategoryGroups()
    const name = (cid: string | null) =>
      groups.flatMap((g) => g.categories).find((c) => c.id === cid)?.name ?? null

    const toVisa = all.find(
      (t) => t.accountId === id('Checking') && t.transferAccountId === id('Visa'),
    )!
    expect(toVisa).toMatchObject({ amount: -4000, payee: null, cleared: true })
    expect(toVisa.splits[0]!.categoryId).toBeNull()
    const fromChecking = all.find(
      (t) => t.accountId === id('Visa') && t.transferAccountId === id('Checking'),
    )!
    expect(fromChecking).toMatchObject({ amount: 4000, cleared: false })
    expect(fromChecking.transferPairId).toBe(toVisa.transferPairId)

    const toBrokerage = all.find(
      (t) => t.transferAccountId === id('Brokerage') && t.accountId === id('Checking'),
    )!
    expect(name(toBrokerage.splits[0]!.categoryId)).toBe('Retirement')
    const brokerageLeg = all.find((t) => t.accountId === id('Brokerage'))!
    expect(brokerageLeg.splits[0]!.categoryId).toBeNull()

    const stray = all.find((t) => t.payee === 'Transfer : Old Account')!
    expect(stray).toMatchObject({ amount: -1000, transferPairId: null })
  })

  it('matches YNAB’s own Budget.csv for the month', async () => {
    const { api } = await makeApi()
    const result = await api.importYnab(input())
    expect(result.mismatches).toEqual([])
    expect(result.mismatchCount).toBe(0)
    expect(await api.getReadyToAssign('2026-10')).toBe(
      // $5,000 starting balance and $3,000 pay, less $750 assigned, less the $10 transfer
      // to an account that isn't in the file, which has no category
      500000 + 300000 - 75000 - 1000,
    )
  })

  it('reports where its numbers differ from YNAB’s instead of hiding it', async () => {
    const { api } = await makeApi()
    const wrong = BUDGET.replace('$219.50', '$300.00')
    const result = await api.importYnab(input({ budget: wrong }))
    expect(result.mismatchCount).toBe(1)
    expect(result.mismatches).toEqual([
      {
        month: '2026-10',
        category: 'Everyday: Groceries',
        field: 'available',
        ynab: 30000,
        ours: 21950,
      },
    ])
  })

  it('puts a card’s purchases and payments through its payment category', async () => {
    const { api } = await makeApi()
    await api.importYnab(input())
    const visa = (await api.listAccounts()).find((a) => a.name === 'Visa')!
    const groups = await api.listCategoryGroups()
    const payment = groups
      .flatMap((g) => g.categories)
      .find((c) => c.creditCardAccountId === visa.id)!
    const oct = await api.getMonthBalances('2026-10')
    // $40 purchase moved in, $40 payment drew it back down
    expect(oct.find((b) => b.categoryId === payment.id)).toMatchObject({ available: 0 })
  })

  it('imports into an existing account instead of making one', async () => {
    const { api } = await makeApi()
    const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
    const result = await api.importYnab(
      input({ accounts: { ...CHOICES, Checking: { accountId: checking.id } } }),
    )
    expect(result.accountsCreated).toBe(2)
    expect((await api.listTransactions({ accountId: checking.id })).length).toBe(7)
  })

  it('reuses categories that already exist, by group and name, ignoring case', async () => {
    const { api } = await makeApi()
    const group = await api.createCategoryGroup({ name: 'everyday' })
    await api.createCategory({ groupId: group.id, name: 'GROCERIES' })
    const result = await api.importYnab(input())
    expect(result).toMatchObject({ groupsCreated: 2, categoriesCreated: 3 })
    expect(result.mismatchCount).toBe(0)
  })

  it('hides YNAB’s Hidden Categories group', async () => {
    const { api } = await makeApi()
    const register = REGISTER.replace(
      'Auto: Fuel,Auto,Fuel',
      'Hidden Categories: Old,Hidden Categories,Old',
    )
    await api.importYnab(input({ register, budget: undefined }))
    const hidden = (await api.listCategoryGroups()).find((g) => g.name === 'Hidden Categories')!
    expect(hidden.hidden).toBe(true)
    expect(hidden.categories[0]).toMatchObject({ name: 'Old', hidden: true })
  })

  it('refuses a second import', async () => {
    const { api } = await makeApi()
    await api.importYnab(input())
    await expect(
      api.importYnab(
        input({
          accounts: {
            Checking: { create: { type: 'checking', onBudget: true } },
            Visa: { create: { type: 'credit', onBudget: true } },
            Brokerage: { create: { type: 'investment', onBudget: false } },
          },
        }),
      ),
    ).rejects.toThrow(/already been imported/)
  })

  it('needs a destination for every account', async () => {
    const { api } = await makeApi()
    await expect(
      api.importYnab(input({ accounts: { Checking: CHOICES.Checking, Visa: CHOICES.Visa } })),
    ).rejects.toThrow(/“Brokerage”/)
  })

  it('changes nothing when part of it fails', async () => {
    const { api } = await makeApi()
    // two YNAB accounts cannot share one destination
    const checking = await api.createAccount({ name: 'Main', type: 'checking' })
    await expect(
      api.importYnab(
        input({
          accounts: {
            Checking: { accountId: checking.id },
            Visa: { accountId: checking.id },
            Brokerage: CHOICES.Brokerage,
          },
        }),
      ),
    ).rejects.toThrow(/same account/)
    expect((await api.listAccounts()).map((a) => a.name)).toEqual(['Main'])
    expect(await api.listTransactions()).toEqual([])
    expect(await api.listCategoryGroups()).toEqual([])
  })

  it('refuses a closed or unknown destination and a name already taken', async () => {
    const { api } = await makeApi()
    const old = await api.createAccount({ name: 'Old', type: 'checking' })
    await api.updateAccount(old.id, { closed: true })
    await expect(
      api.importYnab(input({ accounts: { ...CHOICES, Checking: { accountId: old.id } } })),
    ).rejects.toThrow(/closed/)
    await expect(
      api.importYnab(input({ accounts: { ...CHOICES, Checking: { accountId: 'nope' } } })),
    ).rejects.toThrow(/no longer exists/)
    await api.createAccount({ name: 'visa', type: 'credit' })
    await expect(api.importYnab(input())).rejects.toThrow(/already exists/)
  })

  it('refuses an investment account on budget', async () => {
    const { api } = await makeApi()
    await expect(
      api.importYnab(
        input({
          accounts: { ...CHOICES, Brokerage: { create: { type: 'investment', onBudget: true } } },
        }),
      ),
    ).rejects.toThrow(/tracking accounts/)
  })
})
