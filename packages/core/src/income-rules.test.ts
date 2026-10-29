import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { incomeRuleShares, reduceDeposit, ruleMatches } from './income-rules.ts'
import { cents } from './money.ts'
import { ADJUSTMENT_PAYEE } from './reconcile.ts'
import { openMemoryAdapter } from './test-utils.ts'

const OCT = '2026-10'
const NOV = '2026-11'

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
  const group = await api.createCategoryGroup({ name: 'Giving' })
  const tithe = await api.createCategory({ groupId: group.id, name: 'Tithe' })
  const savings = await api.createCategory({ groupId: group.id, name: 'Savings' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  const brokerage = await api.createAccount({ name: 'Brokerage', type: 'investment' })
  return { api, adapter, tithe, savings, checking, brokerage, group }
}

type Ctx = Awaited<ReturnType<typeof makeApi>>

const paycheck = (c: Ctx, over: Record<string, unknown> = {}) => ({
  accountId: c.checking.id,
  date: '2026-10-15',
  payee: 'Acme Payroll',
  amount: 100_000,
  ...over,
})

/** Net of every entry the rules made for a category, across all months. */
async function given(c: Ctx, categoryId: string) {
  const all = await c.api.listAllocations({ categoryId })
  return all.filter((a) => a.source === 'rule').reduce((sum, a) => sum + a.amount, 0)
}

describe('incomeRuleShares', () => {
  const pct = (percent: number, basis: 'net' | 'gross' = 'net') => ({
    basis,
    percent,
    fixedAmount: null,
  })
  const fixed = (amount: number) => ({ basis: 'net' as const, percent: null, fixedAmount: amount })

  it('rounds a percent to the cent and leaves the rest', () => {
    const [tithe] = incomeRuleShares([pct(10)], { net: 123_457, gross: null })
    expect(tithe!.amount).toBe(12_346)
  })

  it('takes a gross percent of the gross pay', () => {
    const [a, b] = incomeRuleShares([pct(10, 'gross'), pct(10)], { net: 241_137, gross: 310_000 })
    expect(a!.amount).toBe(31_000)
    expect(b!.amount).toBe(24_114)
  })

  it('gives nothing, and says why, when a gross rule has no gross amount', () => {
    const [a] = incomeRuleShares([pct(10, 'gross')], { net: 100_000, gross: null })
    expect(a).toMatchObject({ amount: 0, needsGross: true })
  })

  it('runs in order and never gives away more than the deposit', () => {
    const shares = incomeRuleShares([fixed(120_000), pct(50), fixed(1_000)], {
      net: 150_000,
      gross: null,
    })
    expect(shares.map((s) => s.amount)).toEqual([120_000, 30_000, 0])
  })

  it('shrinks gross with the net when part of a deposit is taken back', () => {
    expect(reduceDeposit({ net: 100_000, gross: 130_000 }, 40_000)).toEqual({
      net: 60_000,
      gross: 78_000,
    })
    expect(reduceDeposit({ net: 100_000, gross: null }, 150_000)).toEqual({ net: 0, gross: null })
  })

  it('never hands out a negative amount or more than came in', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000_000 }),
        fc.option(fc.integer({ min: 1, max: 80_000_000 }), { nil: null }),
        fc.array(
          fc.oneof(
            fc.record({
              basis: fc.constantFrom('net' as const, 'gross' as const),
              percent: fc.integer({ min: 1, max: 100_000 }).map((n) => n / 1000),
              fixedAmount: fc.constant(null),
            }),
            fc.record({
              basis: fc.constant('net' as const),
              percent: fc.constant(null),
              fixedAmount: fc.integer({ min: 1, max: 60_000_000 }),
            }),
          ),
          { maxLength: 6 },
        ),
        (net, gross, rules) => {
          const shares = incomeRuleShares(rules, { net: cents(net), gross })
          const total = shares.reduce((sum, s) => sum + s.amount, 0)
          expect(shares.every((s) => s.amount >= 0)).toBe(true)
          expect(total).toBeLessThanOrEqual(net)
        },
      ),
    )
  })
})

describe('ruleMatches', () => {
  const deposit = { accountId: 'a1', payee: 'ACME PAYROLL #44' }

  it('needs the payee’s words, the account, or both', () => {
    expect(ruleMatches({ match: 'acme payroll', accountId: null }, deposit)).toBe(true)
    expect(ruleMatches({ match: 'acme', accountId: 'a1' }, deposit)).toBe(true)
    expect(ruleMatches({ match: 'acme', accountId: 'a2' }, deposit)).toBe(false)
    expect(ruleMatches({ match: null, accountId: 'a1' }, deposit)).toBe(true)
    expect(ruleMatches({ match: 'pay', accountId: null }, deposit)).toBe(false)
    expect(ruleMatches({ match: null, accountId: null }, deposit)).toBe(false)
  })
})

describe('income rules', () => {
  it('assigns a paycheck to the rule’s category as it is entered', async () => {
    const c = await makeApi()
    await c.api.createIncomeRule({
      name: 'Tithe',
      match: 'Acme Payroll',
      percent: 10,
      categoryId: c.tithe.id,
    })
    await c.api.createTransaction(paycheck(c))
    expect(await given(c, c.tithe.id)).toBe(10_000)
    const [entry] = await c.api.listAllocations({ categoryId: c.tithe.id })
    expect(entry).toMatchObject({ month: OCT, source: 'rule', note: 'Tithe', amount: 10_000 })
    expect(await c.api.getReadyToAssign(OCT)).toBe(90_000)
    const balance = (await c.api.getMonthBalances(OCT)).find((b) => b.categoryId === c.tithe.id)
    expect(balance).toMatchObject({ assigned: 10_000, available: 10_000 })
  })

  it('runs every matching rule by priority and leaves the remainder in Ready to Assign', async () => {
    const c = await makeApi()
    await c.api.createIncomeRule({
      name: 'Savings',
      match: 'Acme',
      percent: 5,
      categoryId: c.savings.id,
      priority: 2,
    })
    await c.api.createIncomeRule({
      name: 'Tithe',
      match: 'Acme',
      percent: 10,
      categoryId: c.tithe.id,
      priority: 1,
    })
    expect((await c.api.listIncomeRules()).map((r) => r.name)).toEqual(['Tithe', 'Savings'])
    await c.api.createTransaction(paycheck(c, { amount: 123_457 }))
    expect(await given(c, c.tithe.id)).toBe(12_346)
    expect(await given(c, c.savings.id)).toBe(6_173)
    expect(await c.api.getReadyToAssign(OCT)).toBe(123_457 - 12_346 - 6_173)
  })

  it('caps the rules at what the deposit holds', async () => {
    const c = await makeApi()
    await c.api.createIncomeRule({
      name: 'Big',
      match: 'Acme',
      fixedAmount: 80_000,
      categoryId: c.tithe.id,
      priority: 1,
    })
    await c.api.createIncomeRule({
      name: 'More',
      match: 'Acme',
      percent: 50,
      categoryId: c.savings.id,
      priority: 2,
    })
    await c.api.createTransaction(paycheck(c))
    expect(await given(c, c.tithe.id)).toBe(80_000)
    expect(await given(c, c.savings.id)).toBe(20_000)
    expect(await c.api.getReadyToAssign(OCT)).toBe(0)
  })

  it('takes a gross percent once the gross pay is known', async () => {
    const c = await makeApi()
    await c.api.createIncomeRule({
      name: 'Tithe',
      match: 'Acme',
      percent: 10,
      basis: 'gross',
      categoryId: c.tithe.id,
    })
    const t = await c.api.createTransaction(paycheck(c, { amount: 241_137 }))
    expect(await given(c, c.tithe.id)).toBe(0)
    await c.api.updateTransaction(t.id, { grossAmount: 310_000 })
    expect(await given(c, c.tithe.id)).toBe(31_000)
    await c.api.updateTransaction(t.id, { grossAmount: 300_000 })
    expect(await given(c, c.tithe.id)).toBe(30_000)
    await c.api.updateTransaction(t.id, { grossAmount: null })
    expect(await given(c, c.tithe.id)).toBe(0)
  })

  it('leaves alone anything that is not income', async () => {
    const c = await makeApi()
    await c.api.createIncomeRule({
      name: 'Tithe',
      accountId: c.checking.id,
      percent: 10,
      categoryId: c.tithe.id,
    })
    await c.api.createTransaction(paycheck(c, { categoryId: c.savings.id }))
    await c.api.createTransaction(paycheck(c, { amount: -5_000 }))
    await c.api.createTransfer({
      fromAccountId: c.brokerage.id,
      toAccountId: c.checking.id,
      date: '2026-10-16',
      amount: 50_000,
    })
    await c.api.createTransaction(paycheck(c, { payee: ADJUSTMENT_PAYEE }))
    await c.api.createTransaction({
      accountId: c.brokerage.id,
      date: '2026-10-16',
      payee: 'Dividend',
      amount: 9_000,
    })
    expect(await c.api.listAllocations()).toEqual([])
  })

  it('waits for an imported deposit to be approved', async () => {
    const c = await makeApi()
    await c.api.mapExternalAccount({ externalId: 'X', name: 'Chase', accountId: c.checking.id })
    await c.api.createIncomeRule({
      name: 'Tithe',
      match: 'Acme',
      percent: 10,
      categoryId: c.tithe.id,
    })
    await c.api.importTransactions([
      {
        id: 'X',
        name: 'Chase',
        transactions: [
          { id: 'P1', posted: '2026-10-15', amount: 100_000, description: 'ACME PAYROLL' },
        ],
      },
    ])
    expect(await c.api.listAllocations()).toEqual([])
    const [item] = await c.api.listInbox()
    await c.api.approveTransactions([item!.transaction.id])
    expect(await given(c, c.tithe.id)).toBe(10_000)
    // Approving again changes nothing.
    await c.api.approveTransactions([item!.transaction.id])
    expect(await c.api.listAllocations()).toHaveLength(1)
  })

  it('follows an edit to the deposit with a correcting entry', async () => {
    const c = await makeApi()
    await c.api.createIncomeRule({
      name: 'Tithe',
      match: 'Acme',
      percent: 10,
      categoryId: c.tithe.id,
    })
    const t = await c.api.createTransaction(paycheck(c))
    await c.api.updateTransaction(t.id, { amount: 120_000 })
    expect(await given(c, c.tithe.id)).toBe(12_000)
    expect((await c.api.listAllocations({ categoryId: c.tithe.id })).map((a) => a.amount)).toEqual([
      10_000, 2_000,
    ])
    // Moving it to another month moves what was given.
    await c.api.updateTransaction(t.id, { date: '2026-11-02' })
    const byMonth = (await c.api.listAllocations({ categoryId: c.tithe.id })).reduce<
      Record<string, number>
    >((m, a) => ({ ...m, [a.month]: (m[a.month] ?? 0) + a.amount }), {})
    expect(byMonth).toEqual({ [OCT]: 0, [NOV]: 12_000 })
    // Categorizing it makes it something other than income.
    await c.api.updateTransaction(t.id, { categoryId: c.savings.id })
    expect(await given(c, c.tithe.id)).toBe(0)
  })

  it('reverses what it gave when the deposit is deleted', async () => {
    const c = await makeApi()
    await c.api.createIncomeRule({
      name: 'Tithe',
      match: 'Acme',
      percent: 10,
      categoryId: c.tithe.id,
    })
    const t = await c.api.createTransaction(paycheck(c))
    await c.api.deleteTransaction(t.id)
    expect(await given(c, c.tithe.id)).toBe(0)
    expect(await c.api.getReadyToAssign(OCT)).toBe(0)
    const entries = await c.api.listAllocations({ categoryId: c.tithe.id })
    expect(entries.map((a) => [a.amount, a.note])).toEqual([
      [10_000, 'Tithe'],
      [-10_000, 'Tithe (reversed)'],
    ])
  })

  it('shows in the activity feed as an allocation, with its reversal', async () => {
    const c = await makeApi()
    await c.api.createIncomeRule({
      name: 'Tithe',
      match: 'Acme',
      percent: 10,
      categoryId: c.tithe.id,
    })
    const t = await c.api.createTransaction(paycheck(c))
    await c.api.deleteTransaction(t.id)
    const { events } = await c.api.listActivity()
    const allocations = events.filter((e) => e.table === 'allocations').map((e) => e.summary)
    expect(allocations).toEqual([
      'Took $100.00 out of Tithe for 2026-10',
      'Assigned $100.00 to Tithe for 2026-10',
    ])
  })

  describe('reversed income', () => {
    async function withPaycheck() {
      const c = await makeApi()
      await c.api.createIncomeRule({
        name: 'Tithe',
        match: 'Acme',
        percent: 10,
        basis: 'gross',
        categoryId: c.tithe.id,
      })
      const deposit = await c.api.createTransaction(
        paycheck(c, { amount: 100_000, grossAmount: 130_000 }),
      )
      return { c, deposit }
    }

    it('takes the rule allocations back when a payroll reversal is linked', async () => {
      const { c, deposit } = await withPaycheck()
      expect(await given(c, c.tithe.id)).toBe(13_000)
      await c.api.createTransaction({
        accountId: c.checking.id,
        date: '2026-11-03',
        payee: 'Acme Payroll reversal',
        amount: -100_000,
        reversesId: deposit.id,
      })
      expect(await given(c, c.tithe.id)).toBe(0)
      // October keeps what it was given; the reversal lands in November.
      const balances = async (m: string) =>
        (await c.api.getMonthBalances(m)).find((b) => b.categoryId === c.tithe.id)!
      expect((await balances(OCT)).assigned).toBe(13_000)
      expect((await balances(NOV)).assigned).toBe(-13_000)
    })

    it('scales the rules to the part of the deposit that is left', async () => {
      const { c, deposit } = await withPaycheck()
      const reversal = await c.api.createTransaction({
        accountId: c.checking.id,
        date: '2026-10-20',
        payee: 'Acme Payroll',
        amount: -40_000,
        reversesId: deposit.id,
      })
      // 60% of the deposit remains, so 60% of the 130,000 gross.
      expect(await given(c, c.tithe.id)).toBe(7_800)
      await c.api.updateTransaction(reversal.id, { amount: -100_000 })
      expect(await given(c, c.tithe.id)).toBe(0)
      await c.api.updateTransaction(reversal.id, { reversesId: null })
      expect(await given(c, c.tithe.id)).toBe(13_000)
    })

    it('restores the allocations when the reversal is deleted', async () => {
      const { c, deposit } = await withPaycheck()
      const reversal = await c.api.createTransaction({
        accountId: c.checking.id,
        date: '2026-10-20',
        payee: 'Acme Payroll',
        amount: -100_000,
        reversesId: deposit.id,
      })
      await c.api.deleteTransaction(reversal.id)
      expect(await given(c, c.tithe.id)).toBe(13_000)
    })

    it('only lets an outflow reverse a deposit', async () => {
      const { c, deposit } = await withPaycheck()
      const base = { accountId: c.checking.id, date: '2026-10-20' }
      await expect(
        c.api.createTransaction({ ...base, amount: 5_000, reversesId: deposit.id }),
      ).rejects.toThrow(/outflow/)
      await expect(
        c.api.createTransaction({ ...base, amount: -5_000, reversesId: 'nope' }),
      ).rejects.toThrow(/not found/)
      const outflow = await c.api.createTransaction({ ...base, amount: -5_000 })
      await expect(
        c.api.createTransaction({ ...base, amount: -5_000, reversesId: outflow.id }),
      ).rejects.toThrow(/deposit/)
    })
  })

  describe('when rules change', () => {
    it('leaves the allocations of a deleted rule, until the deposit itself goes', async () => {
      const c = await makeApi()
      const rule = await c.api.createIncomeRule({
        name: 'Tithe',
        match: 'Acme',
        percent: 10,
        categoryId: c.tithe.id,
      })
      const t = await c.api.createTransaction(paycheck(c))
      await c.api.deleteIncomeRule(rule.id)
      expect(await given(c, c.tithe.id)).toBe(10_000)
      await c.api.updateTransaction(t.id, { amount: 200_000 })
      expect(await given(c, c.tithe.id)).toBe(10_000)
      await c.api.deleteTransaction(t.id)
      expect(await given(c, c.tithe.id)).toBe(0)
    })

    it('applies a new rule to past income only when asked, and only once', async () => {
      const c = await makeApi()
      await c.api.createTransaction(paycheck(c))
      await c.api.createTransaction(paycheck(c, { date: '2026-10-29', amount: 50_000 }))
      await c.api.createIncomeRule({
        name: 'Tithe',
        match: 'Acme',
        percent: 10,
        categoryId: c.tithe.id,
      })
      expect(await given(c, c.tithe.id)).toBe(0)
      expect(await c.api.applyIncomeRules(OCT)).toEqual({ deposits: 2, allocations: 2 })
      expect(await given(c, c.tithe.id)).toBe(15_000)
      expect(await c.api.applyIncomeRules(OCT)).toEqual({ deposits: 2, allocations: 0 })
      expect(await c.api.applyIncomeRules(NOV)).toEqual({ deposits: 0, allocations: 0 })
    })

    it('reverses a rule that no longer fits when the rule is applied again', async () => {
      const c = await makeApi()
      const rule = await c.api.createIncomeRule({
        name: 'Tithe',
        match: 'Acme',
        percent: 10,
        categoryId: c.tithe.id,
      })
      await c.api.createTransaction(paycheck(c))
      await c.api.updateIncomeRule(rule.id, { match: 'Globex' })
      await c.api.applyIncomeRules(OCT)
      expect(await given(c, c.tithe.id)).toBe(0)
    })

    it('stops giving money to a goal once it is archived', async () => {
      const c = await makeApi()
      const goal = await c.api.createGoal({
        categoryId: c.savings.id,
        name: 'Roof',
        targetAmount: 500_000,
      })
      await c.api.createIncomeRule({
        name: 'Roof',
        match: 'Acme',
        percent: 5,
        categoryId: c.savings.id,
        goalId: goal.id,
      })
      await c.api.createTransaction(paycheck(c))
      expect((await c.api.listAllocations({ goalId: goal.id }))[0]?.amount).toBe(5_000)
      await c.api.archiveGoal(goal.id, { month: OCT })
      await c.api.createTransaction(paycheck(c, { date: '2026-10-30' }))
      const fromRules = (await c.api.listAllocations({ goalId: goal.id })).filter(
        (a) => a.source === 'rule',
      )
      expect(fromRules.map((a) => a.amount)).toEqual([5_000])
    })
  })

  describe('validation', () => {
    const base = (c: Ctx) => ({ name: 'Tithe', match: 'Acme', percent: 10, categoryId: c.tithe.id })

    it('needs something to match and exactly one amount', async () => {
      const c = await makeApi()
      await expect(c.api.createIncomeRule({ ...base(c), match: null })).rejects.toThrow(
        /payee, an account, or both/,
      )
      await expect(c.api.createIncomeRule({ ...base(c), fixedAmount: 500 })).rejects.toThrow(
        /either a percent or a fixed amount/,
      )
      await expect(c.api.createIncomeRule({ ...base(c), percent: null })).rejects.toThrow(
        /either a percent or a fixed amount/,
      )
    })

    it('rejects bad amounts and targets', async () => {
      const c = await makeApi()
      for (const percent of [0, 101, 12.3456, Number.NaN]) {
        await expect(c.api.createIncomeRule({ ...base(c), percent })).rejects.toThrow(/Percent/)
      }
      await expect(
        c.api.createIncomeRule({ ...base(c), percent: null, fixedAmount: 12.5 }),
      ).rejects.toThrow(/Fixed amount/)
      await expect(c.api.createIncomeRule({ ...base(c), categoryId: 'missing' })).rejects.toThrow(
        /Category not found/,
      )
      await expect(
        c.api.createIncomeRule({ ...base(c), accountId: c.brokerage.id, match: null }),
      ).rejects.toThrow(/budget account/)
      await expect(c.api.createIncomeRule({ ...base(c), name: ' ' })).rejects.toThrow(/name/)
    })

    it('can’t send money to a credit card’s payment category', async () => {
      const c = await makeApi()
      const card = await c.api.createAccount({ name: 'Visa', type: 'credit' })
      await expect(
        c.api.createIncomeRule({ ...base(c), categoryId: `payment-${card.id}` }),
      ).rejects.toThrow(/payment category/)
    })

    it('keeps the rest of a rule when one thing is edited', async () => {
      const c = await makeApi()
      const rule = await c.api.createIncomeRule(base(c))
      const edited = await c.api.updateIncomeRule(rule.id, { percent: 7.5, basis: 'gross' })
      expect(edited).toMatchObject({ match: 'Acme', percent: 7.5, basis: 'gross', name: 'Tithe' })
      await expect(c.api.updateIncomeRule(rule.id, { fixedAmount: 100 })).rejects.toThrow(
        /either a percent or a fixed amount/,
      )
      const swapped = await c.api.updateIncomeRule(rule.id, { percent: null, fixedAmount: 100 })
      expect(swapped).toMatchObject({ percent: null, fixedAmount: 100 })
    })

    it('goes away with its category, goal or account', async () => {
      const c = await makeApi()
      const goal = await c.api.createGoal({
        categoryId: c.savings.id,
        name: 'Roof',
        targetAmount: 500_000,
      })
      await c.api.createIncomeRule({ ...base(c), goalId: undefined })
      await c.api.createIncomeRule({
        name: 'Roof',
        match: 'Acme',
        percent: 5,
        categoryId: c.savings.id,
        goalId: goal.id,
      })
      const spare = await c.api.createAccount({ name: 'Spare', type: 'checking' })
      await c.api.createIncomeRule({
        name: 'Spare',
        accountId: spare.id,
        percent: 1,
        categoryId: c.savings.id,
      })
      await c.api.deleteAccount(spare.id)
      expect((await c.api.listIncomeRules()).map((r) => r.name)).toEqual(['Tithe', 'Roof'])
      await c.api.deleteGoal(goal.id)
      expect((await c.api.listIncomeRules()).map((r) => r.name)).toEqual(['Tithe'])
      await c.api.deleteCategory(c.tithe.id)
      expect(await c.api.listIncomeRules()).toEqual([])
    })
  })

  describe('report', () => {
    it('shows what the rules give a month beside what is assigned', async () => {
      const c = await makeApi()
      await c.api.createTransaction(paycheck(c, { amount: 241_137, grossAmount: 310_000 }))
      await c.api.createIncomeRule({
        name: 'Tithe',
        match: 'Acme',
        percent: 10,
        basis: 'gross',
        categoryId: c.tithe.id,
      })
      // A person had already budgeted tithe by hand.
      await c.api.allocate({ month: OCT, categoryId: c.tithe.id, amount: 31_000 })

      const before = await c.api.getIncomeRulesReport(OCT)
      expect(before.deposits).toHaveLength(1)
      expect(before.deposits[0]).toMatchObject({
        amount: 241_137,
        gross: 310_000,
        remainder: 210_137,
        settled: false,
        lines: [{ ruleName: 'Tithe', expected: 31_000, assigned: 0, needsGross: false }],
      })
      expect(before.targets).toEqual([
        { categoryId: c.tithe.id, goalId: null, expected: 31_000, fromRules: 0, assigned: 31_000 },
      ])

      await c.api.applyIncomeRules(OCT)
      const after = await c.api.getIncomeRulesReport(OCT)
      expect(after.deposits[0]!.settled).toBe(true)
      expect(after.targets[0]).toMatchObject({
        expected: 31_000,
        fromRules: 31_000,
        assigned: 62_000,
      })
    })
  })
})

describe('a real month: the tithe rule', () => {
  // Two paychecks and a reimbursement, as they would sit in the register.
  it('gives 10% of gross on each paycheck and nothing on the rest', async () => {
    const c = await makeApi()
    await c.api.createIncomeRule({
      name: 'Tithe',
      match: 'Acme Payroll',
      accountId: c.checking.id,
      percent: 10,
      basis: 'gross',
      categoryId: c.tithe.id,
      priority: 1,
    })
    await c.api.createTransaction(
      paycheck(c, { date: '2026-10-02', amount: 241_137, grossAmount: 310_000 }),
    )
    await c.api.createTransaction(
      paycheck(c, { date: '2026-10-16', amount: 241_137, grossAmount: 310_000 }),
    )
    await c.api.createTransaction(
      paycheck(c, { date: '2026-10-20', payee: 'Venmo from Sam', amount: 4_500 }),
    )
    const balance = (await c.api.getMonthBalances(OCT)).find((b) => b.categoryId === c.tithe.id)
    expect(balance).toMatchObject({ assigned: 62_000, available: 62_000 })
    expect(await c.api.getReadyToAssign(OCT)).toBe(2 * 241_137 + 4_500 - 62_000)
    const report = await c.api.getIncomeRulesReport(OCT)
    expect(report.deposits.map((d) => d.settled)).toEqual([true, true, true])
  })
})
