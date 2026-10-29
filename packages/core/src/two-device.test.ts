import { beforeEach, describe, expect, it } from 'vitest'
import { SYNCED_TABLES } from './sync.ts'
import { A, B, Device, FakeServer, T0 } from './sync-test-utils.ts'

const OCT = '2026-10'
const NOV = '2026-11'

let server: FakeServer
let a: Device
let b: Device
let checking: string
let savings: string
let groceries: string
let fun: string

/** Every synced table, row by row, in a fixed order: what "the same budget" means. */
async function dump(d: Device) {
  const out: Record<string, unknown[]> = {}
  for (const table of SYNCED_TABLES) {
    out[table] = await d.adapter.query(`SELECT * FROM ${table} ORDER BY id`)
  }
  return out
}

/** What each person sees on screen, derived from the ledger. */
async function views(d: Device) {
  return {
    transactions: await d.api.listTransactions(),
    balances: await d.api.getAccountBalances(),
    groups: await d.api.listCategoryGroups(),
    oct: await d.api.getMonthBalances(OCT),
    nov: await d.api.getMonthBalances(NOV),
    readyOct: await d.api.getReadyToAssign(OCT),
    readyNov: await d.api.getReadyToAssign(NOV),
  }
}

/** Both devices come back online, one after the other, until nothing is left to exchange. */
async function converge() {
  for (const d of [a, b, a, b]) {
    const result = await d.api.syncNow()
    expect(result.failed).toEqual([])
  }
  expect((await a.api.syncNow()).converged).toBe(true)
  expect((await b.api.syncNow()).converged).toBe(true)
  expect(await dump(b)).toEqual(await dump(a))
  expect(await views(b)).toEqual(await views(a))
  expect((await a.api.getSyncStatus()).pending).toBe(0)
  expect((await b.api.getSyncStatus()).pending).toBe(0)
}

beforeEach(async () => {
  server = new FakeServer()
  a = await Device.create(A, server)
  b = await Device.create(B, server)
  await a.api.syncNow()
  await b.api.syncNow()

  // A budget set up on A and already shared, as it would be in daily use.
  checking = (await a.api.createAccount({ name: 'Checking', type: 'checking' })).id
  savings = (await a.api.createAccount({ name: 'Savings', type: 'savings' })).id
  const group = await a.api.createCategoryGroup({ name: 'Everyday' })
  groceries = (await a.api.createCategory({ groupId: group.id, name: 'Groceries' })).id
  fun = (await a.api.createCategory({ groupId: group.id, name: 'Fun' })).id
  await a.api.createTransaction({
    accountId: checking,
    date: '2026-10-01',
    payee: 'Paycheck',
    amount: 500_000,
    cleared: true,
  })
  await a.api.allocate({ month: OCT, categoryId: groceries, amount: 60_000 })
  await converge()
})

describe('importing from the bank on two devices', () => {
  const data = [
    {
      id: 'ACT-1',
      name: 'Chase Checking',
      transactions: [
        { id: 'T1', posted: '2026-10-05', amount: -4_250, description: 'KROGER' },
        { id: 'T2', posted: '2026-10-06', amount: -900, description: 'COFFEE' },
      ],
    },
  ]

  beforeEach(async () => {
    await a.api.mapExternalAccount({ externalId: 'ACT-1', name: 'Chase', accountId: checking })
    await converge()
  })

  it('shares the account mapping', async () => {
    expect(await b.api.listAccountMappings()).toEqual([
      { externalId: 'ACT-1', name: 'Chase', org: '', accountId: checking },
    ])
  })

  it('lands one row per bank transaction when both devices import the same fetch', async () => {
    await a.api.importTransactions(data)
    await b.api.importTransactions(data)
    await converge()
    const inbox = await a.api.listInbox()
    expect(inbox.map((i) => i.transaction.importId)).toEqual(['ACT-1:T1', 'ACT-1:T2'])
    expect(await a.api.listTransactions()).toHaveLength(3)
  })

  it('shows an approval made on one device on the other', async () => {
    await a.api.importTransactions(data)
    await converge()
    const [first] = await b.api.listInbox()
    await b.api.updateTransaction(first!.transaction.id, { categoryId: groceries })
    await b.api.approveTransactions([first!.transaction.id])
    await converge()
    expect((await a.api.listInbox()).map((i) => i.transaction.importId)).toEqual(['ACT-1:T2'])
  })

  it('uses a payee rule made on the other device', async () => {
    await a.api.createPayeeRule({ match: 'kroger', categoryId: groceries })
    await converge()
    await b.api.importTransactions(data)
    await converge()
    const inbox = await a.api.listInbox()
    expect(inbox.map((i) => i.transaction.splits[0]!.categoryId)).toEqual([groceries, null])
  })

  it('keeps a dismissed transaction dismissed on both devices', async () => {
    await a.api.importTransactions(data)
    await converge()
    const [first] = await b.api.listInbox()
    await b.api.deleteTransaction(first!.transaction.id)
    await converge()
    expect(await a.api.importTransactions(data)).toMatchObject({ added: 0, dismissed: 1 })
    expect(await a.api.listInbox()).toHaveLength(1)
  })
})

describe('importing YNAB history', () => {
  const register = [
    'Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared',
    'Joint,,10/02/2026,Paycheck,Inflow: Ready to Assign,Inflow,Ready to Assign,,$0.00,"$2,000.00",Cleared',
    'Joint,,10/15/2026,Costco,Household: Supplies,Household,Supplies,(Split 1/2) a,$30.00,$0.00,Cleared',
    'Joint,,10/15/2026,Costco,Household: Pets,Household,Pets,(Split 2/2) b,$20.00,$0.00,Cleared',
    'Joint,,10/16/2026,Transfer : Checking,,,,,$100.00,$0.00,Cleared',
    'Checking,,10/16/2026,Transfer : Joint,,,,,$0.00,$100.00,Cleared',
  ].join('\n')
  const budget = [
    'Month,Category Group/Category,Category Group,Category,Budgeted,Activity,Available',
    'October 2026,Household: Supplies,Household,Supplies,$100.00,-$30.00,$70.00',
  ].join('\n')

  it('arrives whole on the other device', async () => {
    const result = await a.api.importYnab({
      register,
      budget,
      accounts: {
        Joint: { create: { type: 'checking', onBudget: true } },
        Checking: { accountId: checking },
      },
    })
    expect(result.mismatchCount).toBe(0)
    await converge()
    expect(await b.api.listAccounts()).toHaveLength(3)
    expect((await b.api.listTransactions()).filter((t) => t.id.startsWith('ynab-'))).toHaveLength(4)
  })

  it('is refused on the other device once it has arrived', async () => {
    const accounts = {
      Joint: { create: { type: 'checking', onBudget: true } },
      Checking: { accountId: checking },
    } as const
    await a.api.importYnab({ register, accounts })
    await converge()
    await expect(b.api.importYnab({ register, accounts })).rejects.toThrow(/already been imported/)
  })
})

describe('two devices editing the same budget offline', () => {
  it('keeps the transactions each device entered', async () => {
    await a.api.createTransaction({
      accountId: checking,
      date: '2026-10-05',
      payee: 'Market',
      categoryId: groceries,
      amount: -8_250,
    })
    await b.api.createTransaction({
      accountId: checking,
      date: '2026-10-05',
      payee: 'Cinema',
      categoryId: fun,
      amount: -3_000,
    })
    await converge()
    expect(await a.api.listTransactions()).toHaveLength(3)
    expect((await a.api.getAccountBalances()).find((x) => x.accountId === checking)?.balance).toBe(
      500_000 - 8_250 - 3_000,
    )
  })

  it('adds both devices’ allocations to the same category and month', async () => {
    await a.api.allocate({ month: OCT, categoryId: groceries, amount: 10_000 })
    await b.api.allocate({ month: OCT, categoryId: groceries, amount: 5_000 })
    await b.api.allocate({ month: OCT, categoryId: groceries, amount: -1_000 })
    await converge()
    const row = (await a.api.getMonthBalances(OCT)).find((c) => c.categoryId === groceries)
    expect(row?.assigned).toBe(60_000 + 10_000 + 5_000 - 1_000)
    expect(await a.api.getReadyToAssign(OCT)).toBe(500_000 - 74_000)
  })

  it('keeps both moves when each device moves money between the same two envelopes', async () => {
    await a.api.moveAllocation({
      month: OCT,
      fromCategoryId: groceries,
      toCategoryId: fun,
      amount: 10_000,
    })
    await b.api.moveAllocation({
      month: OCT,
      fromCategoryId: groceries,
      toCategoryId: fun,
      amount: 20_000,
    })
    await converge()
    const balances = await a.api.getMonthBalances(OCT)
    expect(balances.find((c) => c.categoryId === groceries)?.assigned).toBe(30_000)
    expect(balances.find((c) => c.categoryId === fun)?.assigned).toBe(30_000)
    // Moving money never changes what is left to assign.
    expect(await a.api.getReadyToAssign(OCT)).toBe(500_000 - 60_000)
  })

  it('carries a month’s leftovers into the next the same way on both', async () => {
    await a.api.createTransaction({
      accountId: checking,
      date: '2026-10-20',
      categoryId: groceries,
      amount: -45_000,
    })
    await b.api.allocate({ month: NOV, categoryId: groceries, amount: 20_000 })
    await b.api.createTransaction({
      accountId: checking,
      date: '2026-11-02',
      categoryId: groceries,
      amount: -5_000,
    })
    await converge()
    const nov = (await b.api.getMonthBalances(NOV)).find((c) => c.categoryId === groceries)
    expect(nov?.available).toBe(15_000 + 20_000 - 5_000)
  })

  describe('editing one transaction', () => {
    let txn: string

    beforeEach(async () => {
      txn = (
        await a.api.createTransaction({
          accountId: checking,
          date: '2026-10-06',
          payee: 'Store',
          categoryId: groceries,
          amount: -2_000,
        })
      ).id
      await converge()
    })

    it('keeps edits to different fields from both devices', async () => {
      a.clock = T0 + 10_000
      b.clock = T0 + 20_000
      await a.api.updateTransaction(txn, { categoryId: fun })
      await b.api.updateTransaction(txn, { payee: 'Corner Store', cleared: true })
      await converge()
      expect((await a.api.listTransactions()).find((t) => t.id === txn)).toMatchObject({
        splits: [expect.objectContaining({ categoryId: fun })],
        payee: 'Corner Store',
        cleared: true,
        amount: -2_000,
      })
    })

    it('lets the newest edit to one field win, not the last to sync', async () => {
      a.clock = T0 + 30_000
      b.clock = T0 + 10_000
      await a.api.updateTransaction(txn, { amount: -2_500 })
      await b.api.updateTransaction(txn, { amount: -9_900 })
      // B syncs last, but A's edit is newer.
      await a.api.syncNow()
      await b.api.syncNow()
      await converge()
      expect((await b.api.listTransactions()).find((t) => t.id === txn)?.amount).toBe(-2_500)
    })

    it('removes it everywhere when one device deletes it and the other edits it', async () => {
      a.clock = T0 + 5_000
      b.clock = T0 + 15_000
      await a.api.deleteTransaction(txn)
      await b.api.updateTransaction(txn, { amount: -2_200 })
      await converge()
      expect((await a.api.listTransactions()).find((t) => t.id === txn)).toBeUndefined()
      expect((await b.api.listTransactions()).find((t) => t.id === txn)).toBeUndefined()
    })

    it('settles a split that both devices rewrite', async () => {
      const split = (
        await a.api.createTransaction({
          accountId: checking,
          date: '2026-10-07',
          payee: 'Big box',
          splits: [
            { categoryId: groceries, amount: -6_000 },
            { categoryId: fun, amount: -4_000 },
          ],
        })
      ).id
      await converge()
      a.clock = T0 + 10_000
      b.clock = T0 + 20_000
      await a.api.updateTransaction(split, {
        splits: [
          { categoryId: groceries, amount: -7_000 },
          { categoryId: fun, amount: -3_000 },
        ],
      })
      await b.api.updateTransaction(split, {
        splits: [
          { categoryId: groceries, amount: -5_000 },
          { categoryId: fun, amount: -2_000 },
          { categoryId: null, amount: -3_000 },
        ],
      })
      await converge()
      const merged = (await a.api.listTransactions()).find((t) => t.id === split)!
      // Whatever the winner is, the lines must still add up to the transaction.
      expect(merged.splits.reduce((sum, s) => sum + s.amount, 0)).toBe(merged.amount)
    })
  })

  describe('transfers', () => {
    let out: string
    let into: string

    beforeEach(async () => {
      const [from, to] = await a.api.createTransfer({
        fromAccountId: checking,
        toAccountId: savings,
        date: '2026-10-08',
        amount: 50_000,
      })
      out = from.id
      into = to.id
      await converge()
    })

    it('mirrors an amount edit made on either leg while the other device clears the other', async () => {
      a.clock = T0 + 10_000
      b.clock = T0 + 20_000
      await a.api.updateTransaction(out, { amount: -40_000 })
      await b.api.updateTransaction(into, { cleared: true })
      await converge()
      const all = await a.api.listTransactions()
      expect(all.find((t) => t.id === out)?.amount).toBe(-40_000)
      expect(all.find((t) => t.id === into)).toMatchObject({ amount: 40_000, cleared: true })
    })

    it('deletes both legs when the other device only edits one', async () => {
      a.clock = T0 + 5_000
      b.clock = T0 + 15_000
      await a.api.deleteTransaction(out)
      await b.api.updateTransaction(into, { cleared: true })
      await converge()
      const ids = (await a.api.listTransactions()).map((t) => t.id)
      expect(ids).not.toContain(out)
      expect(ids).not.toContain(into)
    })

    it('keeps one pair of legs when both devices make a transfer offline', async () => {
      await a.api.createTransfer({
        fromAccountId: checking,
        toAccountId: savings,
        date: '2026-10-09',
        amount: 1_000,
      })
      await b.api.createTransfer({
        fromAccountId: savings,
        toAccountId: checking,
        date: '2026-10-09',
        amount: 300,
      })
      await converge()
      const all = await a.api.listTransactions()
      expect(all).toHaveLength(1 + 2 + 4)
      for (const t of all.filter((x) => x.transferAccountId !== null)) {
        const mate = all.find((o) => o.transferPairId === t.transferPairId && o.id !== t.id)
        expect(mate?.amount).toBe(-t.amount)
      }
    })
  })

  describe('accounts and categories', () => {
    it('keeps a rename and a hide made on different devices', async () => {
      await a.api.updateCategory(groceries, { name: 'Food' })
      await b.api.updateCategory(groceries, { hidden: true })
      await converge()
      const category = (await a.api.listCategoryGroups())
        .flatMap((g) => g.categories)
        .find((c) => c.id === groceries)
      expect(category).toMatchObject({ name: 'Food', hidden: true })
    })

    it('settles a category moved to different groups', async () => {
      const g1 = await a.api.createCategoryGroup({ name: 'Bills' })
      const g2 = await a.api.createCategoryGroup({ name: 'Savings goals' })
      await converge()
      a.clock = T0 + 10_000
      b.clock = T0 + 20_000
      await a.api.updateCategory(fun, { groupId: g1.id })
      await b.api.updateCategory(fun, { groupId: g2.id })
      await converge()
      const where = (await a.api.listCategoryGroups()).find((g) =>
        g.categories.some((c) => c.id === fun),
      )
      expect(where?.id).toBe(g2.id)
    })

    it('lets a spending history outlive a category deleted on the other device', async () => {
      const spare = await a.api.createCategory({
        groupId: (await a.api.listCategoryGroups())[0]!.id,
        name: 'Spare',
      })
      await converge()
      await a.api.deleteCategory(spare.id)
      await b.api.allocate({ month: OCT, categoryId: groceries, amount: 100 })
      await converge()
      const names = (await b.api.listCategoryGroups()).flatMap((g) =>
        g.categories.map((c) => c.name),
      )
      expect(names).not.toContain('Spare')
    })

    it('ends with one payment category per card when both devices add the same card', async () => {
      await a.api.createAccount({ name: 'Visa', type: 'credit' })
      await b.api.createAccount({ name: 'Visa', type: 'credit' })
      await converge()
      const groups = (await a.api.listCategoryGroups()).filter(
        (g) => g.id === 'credit-card-payments',
      )
      expect(groups).toHaveLength(1)
      const cards = (await a.api.listAccounts()).filter((x) => x.type === 'credit')
      expect(groups[0]!.categories).toHaveLength(cards.length)
    })
  })

  describe('credit cards', () => {
    it('moves the same money into the payment category from purchases made on both', async () => {
      const visa = (await a.api.createAccount({ name: 'Visa', type: 'credit' })).id
      await converge()
      await a.api.createTransaction({
        accountId: visa,
        date: '2026-10-10',
        categoryId: groceries,
        amount: -12_000,
      })
      await b.api.createTransaction({
        accountId: visa,
        date: '2026-10-11',
        categoryId: fun,
        amount: -7_000,
      })
      await converge()
      const payment = (await a.api.getMonthBalances(OCT)).find(
        (c) => c.categoryId === `payment-${visa}`,
      )
      expect(payment?.available).toBe(19_000)
    })
  })

  describe('reconciliation', () => {
    it('locks the same transactions on both devices', async () => {
      await a.api.reconcileAccount({
        accountId: checking,
        statementBalance: 498_000,
        date: '2026-10-15',
      })
      await b.api.createTransaction({
        accountId: checking,
        date: '2026-10-12',
        payee: 'Late entry',
        categoryId: groceries,
        amount: -1_500,
      })
      await converge()
      const all = await b.api.listTransactions({ accountId: checking })
      expect(all.filter((t) => t.reconciled)).toHaveLength(2)
      expect(all.find((t) => t.payee === 'Late entry')?.reconciled).toBe(false)
      await expect(b.api.deleteTransaction(all.find((t) => t.reconciled)!.id)).rejects.toThrow()
    })

    it('does not post two adjustments’ worth of difference once they have met', async () => {
      await a.api.reconcileAccount({
        accountId: checking,
        statementBalance: 499_000,
        date: '2026-10-15',
      })
      await converge()
      const status = await b.api.getReconciliation(checking)
      expect(status.clearedBalance).toBe(499_000)
      expect(status.toReconcile).toBe(0)
    })
  })

  describe('being offline for a while', () => {
    it('merges days of edits made on both, with clocks that disagree', async () => {
      b.clock = T0 + 90_000 // B’s clock runs ahead
      for (let day = 10; day < 17; day++) {
        const date = `2026-10-${day}`
        await a.api.createTransaction({
          accountId: checking,
          date,
          payee: `A day ${day}`,
          categoryId: groceries,
          amount: -(day * 100),
        })
        await b.api.createTransaction({
          accountId: checking,
          date,
          payee: `B day ${day}`,
          categoryId: fun,
          amount: -(day * 50),
        })
        a.clock += 86_400_000
        b.clock += 86_400_000
      }
      await a.api.allocate({ month: OCT, categoryId: fun, amount: 9_000 })
      await converge()
      expect(await a.api.listTransactions()).toHaveLength(1 + 14)
    })

    it('converges when the two devices sync in the middle of each other’s edits', async () => {
      await a.api.createTransaction({ accountId: checking, date: '2026-10-10', amount: -100 })
      await a.api.syncNow()
      await b.api.createTransaction({ accountId: checking, date: '2026-10-11', amount: -200 })
      await b.api.syncNow()
      await a.api.createTransaction({ accountId: checking, date: '2026-10-12', amount: -300 })
      await b.api.createTransaction({ accountId: checking, date: '2026-10-13', amount: -400 })
      await a.api.syncNow()
      await converge()
      expect(await a.api.listTransactions()).toHaveLength(5)
    })

    it('catches up a device that was away while the other did several rounds', async () => {
      for (let i = 0; i < 4; i++) {
        await a.api.allocate({ month: OCT, categoryId: fun, amount: 1_000 })
        await a.api.syncNow()
      }
      await b.api.allocate({ month: OCT, categoryId: fun, amount: 500 })
      await converge()
      const row = (await b.api.getMonthBalances(OCT)).find((c) => c.categoryId === fun)
      expect(row?.assigned).toBe(4_500)
    })
  })

  describe('a third copy', () => {
    it('sets a fresh device up from the file and then agrees with both', async () => {
      await a.api.createTransaction({ accountId: checking, date: '2026-10-10', amount: -100 })
      await b.api.createTransaction({ accountId: checking, date: '2026-10-11', amount: -200 })
      await converge()
      const c = await Device.create('abcdefabcdefabcd', server)
      await c.api.downloadServerBudget()
      await c.api.createTransaction({ accountId: savings, date: '2026-10-12', amount: 900 })
      await c.api.syncNow()
      await converge()
      await c.api.syncNow()
      expect(await dump(c)).toEqual(await dump(a))
      expect(await views(c)).toEqual(await views(a))
    })
  })
})

/** A small deterministic generator, so a failing seed can be replayed. */
function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('random edits on both devices', () => {
  async function step(d: Device, rand: () => number, label: string) {
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!
    const txns = await d.api.listTransactions()
    const editable = txns.filter((t) => !t.reconciled && t.transferPairId === null)
    const cats = (await d.api.listCategoryGroups()).flatMap((g) => g.categories)
    const spendable = cats.filter((c) => !c.id.startsWith('payment-'))
    d.clock += Math.floor(rand() * 20_000)
    const action = Math.floor(rand() * 9)
    switch (action) {
      case 0:
      case 1:
        await d.api.createTransaction({
          accountId: pick([checking, savings]),
          date: `2026-1${Math.floor(rand() * 2)}-${String(1 + Math.floor(rand() * 27)).padStart(2, '0')}`,
          payee: `${label}-${Math.floor(rand() * 1000)}`,
          categoryId: pick(spendable).id,
          amount: -Math.floor(rand() * 20_000) - 1,
        })
        break
      case 2:
        if (editable.length) {
          await d.api.updateTransaction(pick(editable).id, {
            amount: -Math.floor(rand() * 20_000) - 1,
          })
        }
        break
      case 3:
        if (editable.length) {
          await d.api.updateTransaction(pick(editable).id, { payee: `${label}-edit` })
        }
        break
      case 4:
        if (editable.length && rand() < 0.5) await d.api.deleteTransaction(pick(editable).id)
        break
      case 5:
        await d.api.allocate({
          month: pick([OCT, NOV]),
          categoryId: pick(spendable).id,
          amount: Math.floor(rand() * 20_000) - 5_000,
        })
        break
      case 6:
        await d.api.moveAllocation({
          month: OCT,
          fromCategoryId: groceries,
          toCategoryId: fun,
          amount: 1 + Math.floor(rand() * 5_000),
        })
        break
      case 7:
        await d.api.updateCategory(pick(spendable).id, {
          name: `${label}-cat-${Math.floor(rand() * 99)}`,
        })
        break
      default:
        await d.api.createTransfer({
          fromAccountId: checking,
          toAccountId: savings,
          date: '2026-10-20',
          amount: 1 + Math.floor(rand() * 10_000),
        })
    }
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])('seed %i converges', async (seed) => {
    const rand = random(seed)
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 6; i++) await step(a, rand, 'a')
      for (let i = 0; i < 6; i++) await step(b, rand, 'b')
      // A random subset syncs part-way through, as people’s phones do.
      if (rand() < 0.5) await a.api.syncNow()
      if (rand() < 0.5) await b.api.syncNow()
    }
    await converge()
  })
})
