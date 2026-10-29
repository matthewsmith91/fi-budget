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
    now: () => '2026-10-28T00:00:00.000Z',
  })
  await api.createHousehold({ name: 'Smith', members: ['Matt', 'Jessica'] })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  const brokerage = await api.createAccount({ name: 'Brokerage', type: 'investment' })
  const [group] = await (async () => {
    await api.createCategoryGroup({ name: 'Savings' })
    return api.listCategoryGroups()
  })()
  const savings = await api.createCategory({ groupId: group!.id, name: 'Savings' })
  const house = await api.createGoal({
    categoryId: savings.id,
    name: 'House',
    targetAmount: 1_000_000,
  })
  const car = await api.createGoal({ categoryId: savings.id, name: 'Car', targetAmount: 500_000 })
  return { api, adapter, checking, brokerage, savings, house, car }
}

type Ctx = Awaited<ReturnType<typeof makeApi>>

/** Moves money from checking into the brokerage for a goal. */
function contribute(
  c: Ctx,
  amount: number,
  opts: { date?: string; goalId?: string | null; cleared?: boolean } = {},
) {
  return c.api.createTransfer({
    fromAccountId: c.checking.id,
    toAccountId: c.brokerage.id,
    date: opts.date ?? '2026-10-05',
    amount,
    categoryId: c.savings.id,
    goalId: opts.goalId === undefined ? c.house.id : opts.goalId,
    cleared: opts.cleared ?? true,
  })
}

const goalRow = async (c: Ctx, goalId: string | null) =>
  (await c.api.getAccountInvestments(c.brokerage.id)).goals.find((g) => g.goalId === goalId)

describe('buying units', () => {
  it('buys units for the goal on a cleared contribution at $1 a unit in a new account', async () => {
    const c = await makeApi()
    await contribute(c, 50_000)
    expect(await goalRow(c, c.house.id)).toMatchObject({
      goalName: 'House',
      units: 500,
      value: 50_000,
      costBasis: 50_000,
      gain: 0,
      realized: 0,
    })
  })

  it('waits for the transfer to clear, and is voided if it is uncleared again', async () => {
    const c = await makeApi()
    const [, into] = await contribute(c, 50_000, { cleared: false })
    expect((await c.api.getAccountInvestments(c.brokerage.id)).goals).toEqual([])
    await c.api.updateTransaction(into.id, { cleared: true })
    expect((await goalRow(c, c.house.id))?.units).toBe(500)
    await c.api.updateTransaction(into.id, { cleared: false })
    expect((await c.api.getAccountInvestments(c.brokerage.id)).goals).toEqual([])
    // clearing it again brings the same row back rather than adding another
    await c.api.updateTransaction(into.id, { cleared: true })
    expect((await goalRow(c, c.house.id))?.units).toBe(500)
    expect(await c.api.listUnitEvents(c.brokerage.id)).toHaveLength(1)
  })

  it('prices units from the account value: a gain raises the unit price for everyone', async () => {
    const c = await makeApi()
    await contribute(c, 100_000, { date: '2026-10-01' }) // 1,000 units to House
    await c.api.recordValuation({
      accountId: c.brokerage.id,
      date: '2026-10-10',
      marketValue: 110_000,
    })
    // 110,000 cents over 1,000 units: $1.10 a unit; Car buys at that price
    await contribute(c, 55_000, { date: '2026-10-12', goalId: c.car.id })
    expect(await goalRow(c, c.car.id)).toMatchObject({ units: 500, value: 55_000, gain: 0 })
    expect(await goalRow(c, c.house.id)).toMatchObject({
      units: 1000,
      value: 110_000,
      costBasis: 100_000,
      gain: 10_000,
    })
    // a later valuation moves both in step
    await c.api.recordValuation({
      accountId: c.brokerage.id,
      date: '2026-10-20',
      marketValue: 180_000,
    })
    const result = await c.api.getAccountInvestments(c.brokerage.id)
    expect(result.unitPrice).toBeCloseTo(120, 6)
    expect(await goalRow(c, c.house.id)).toMatchObject({ value: 120_000, gain: 20_000 })
    expect(await goalRow(c, c.car.id)).toMatchObject({ value: 60_000, gain: 5_000 })
    expect(result).toMatchObject({ value: 180_000, costBasis: 155_000, gain: 25_000 })
  })

  it('does not count later contributions against an older valuation', async () => {
    const c = await makeApi()
    await c.api.recordValuation({
      accountId: c.brokerage.id,
      date: '2026-10-01',
      marketValue: 100_000,
    })
    await contribute(c, 10_000, { date: '2026-10-05' })
    await contribute(c, 10_000, { date: '2026-10-20' })
    // both buy at the price of the valuation: $1 a unit
    expect(await goalRow(c, c.house.id)).toMatchObject({ units: 200, costBasis: 20_000, gain: 0 })
  })

  it('gives what the account was already worth to Unassigned', async () => {
    const c = await makeApi()
    await c.api.recordValuation({
      accountId: c.brokerage.id,
      date: '2026-10-01',
      marketValue: 8_420_000,
    })
    await contribute(c, 100_000, { date: '2026-10-05' })
    expect(await goalRow(c, null)).toMatchObject({ value: 8_420_000, costBasis: 8_420_000 })
    expect(await goalRow(c, c.house.id)).toMatchObject({ value: 100_000, gain: 0 })
    expect((await c.api.getAccountInvestments(c.brokerage.id)).value).toBe(8_520_000)
  })

  it('goes to Unassigned when the contribution names no goal', async () => {
    const c = await makeApi()
    await contribute(c, 20_000, { goalId: null })
    expect(await goalRow(c, null)).toMatchObject({ units: 200, value: 20_000 })
  })

  it('re-sizes the purchase, at the same price, when the amount is edited', async () => {
    const c = await makeApi()
    await c.api.recordValuation({
      accountId: c.brokerage.id,
      date: '2026-10-01',
      marketValue: 100_000,
    })
    const [, into] = await contribute(c, 10_000)
    await c.api.recordValuation({
      accountId: c.brokerage.id,
      date: '2026-10-06',
      marketValue: 300_000,
    })
    await c.api.updateTransaction(into.id, { amount: 20_000 })
    expect(await goalRow(c, c.house.id)).toMatchObject({ units: 200, costBasis: 20_000 })
  })

  it('moves to the other goal when the budget leg’s goal is changed', async () => {
    const c = await makeApi()
    const [out] = await contribute(c, 10_000)
    await c.api.updateTransaction(out.id, { goalId: c.car.id })
    expect(await goalRow(c, c.house.id)).toBeUndefined()
    expect(await goalRow(c, c.car.id)).toMatchObject({ units: 100 })
  })

  it('removes the units when the transfer is deleted', async () => {
    const c = await makeApi()
    const [out] = await contribute(c, 10_000)
    await c.api.deleteTransaction(out.id)
    expect(await c.api.listUnitEvents(c.brokerage.id)).toEqual([])
  })

  it('also draws the goal’s budget balance down, like any spending from a goal', async () => {
    const c = await makeApi()
    await c.api.allocate({
      month: '2026-10',
      categoryId: c.savings.id,
      goalId: c.house.id,
      amount: 60_000,
    })
    await contribute(c, 50_000)
    const goals = await c.api.listGoals()
    expect(goals.find((g) => g.id === c.house.id)).toBeDefined()
    const balances = await c.api.getGoalBalances('2026-10')
    expect(balances.find((g) => g.goalId === c.house.id)?.available).toBe(10_000)
  })

  it('refuses a goal without its category and a goal of another category', async () => {
    const c = await makeApi()
    await expect(
      c.api.createTransfer({
        fromAccountId: c.checking.id,
        toAccountId: c.brokerage.id,
        date: '2026-10-05',
        amount: 100,
        goalId: c.house.id,
      }),
    ).rejects.toThrow(/category/)
  })
})

describe('selling units', () => {
  it('sells at the current price and realizes the gain on the cost taken out', async () => {
    const c = await makeApi()
    await contribute(c, 100_000, { date: '2026-10-01' }) // 1,000 units, basis 100,000
    await c.api.recordValuation({
      accountId: c.brokerage.id,
      date: '2026-10-10',
      marketValue: 150_000,
    })
    // withdraw $600 for the goal: 400 of its 1,000 units at $1.50
    await c.api.createTransfer({
      fromAccountId: c.brokerage.id,
      toAccountId: c.checking.id,
      date: '2026-10-12',
      amount: 60_000,
      categoryId: c.savings.id,
      goalId: c.house.id,
      cleared: true,
    })
    expect(await goalRow(c, c.house.id)).toMatchObject({
      units: 600,
      costBasis: 60_000,
      value: 90_000,
      gain: 30_000,
      realized: 20_000,
    })
  })

  it('takes the rest from Unassigned when the goal owns less than the withdrawal', async () => {
    const c = await makeApi()
    await c.api.recordValuation({
      accountId: c.brokerage.id,
      date: '2026-10-01',
      marketValue: 500_000,
    })
    await contribute(c, 10_000, { date: '2026-10-05' })
    await c.api.createTransfer({
      fromAccountId: c.brokerage.id,
      toAccountId: c.checking.id,
      date: '2026-10-12',
      amount: 25_000,
      categoryId: c.savings.id,
      goalId: c.house.id,
      cleared: true,
    })
    expect(await goalRow(c, c.house.id)).toMatchObject({ units: 0, value: 0, realized: 0 })
    expect(await goalRow(c, null)).toMatchObject({ value: 485_000 })
  })

  it('sells nothing for a withdrawal when no units are there to sell', async () => {
    const c = await makeApi()
    await c.api.createTransfer({
      fromAccountId: c.brokerage.id,
      toAccountId: c.checking.id,
      date: '2026-10-12',
      amount: 25_000,
      cleared: true,
    })
    expect(await c.api.listUnitEvents(c.brokerage.id)).toEqual([])
  })
})

describe('dividends', () => {
  it('mints Unassigned units for a cleared inflow that is not a transfer', async () => {
    const c = await makeApi()
    await contribute(c, 100_000, { date: '2026-10-01' })
    await c.api.createTransaction({
      accountId: c.brokerage.id,
      date: '2026-10-15',
      payee: 'Dividend',
      amount: 1_200,
      cleared: true,
    })
    expect(await goalRow(c, null)).toMatchObject({ units: 12, value: 1_200, costBasis: 1_200 })
    // the goals keep their units, so a dividend does not dilute them
    expect(await goalRow(c, c.house.id)).toMatchObject({ units: 1000, value: 100_000 })
  })

  it('waits for an imported dividend to be approved', async () => {
    const c = await makeApi()
    await c.api.createTransaction({
      accountId: c.brokerage.id,
      date: '2026-10-15',
      amount: 1_200,
      cleared: true,
    })
    await c.adapter.exec('UPDATE transactions SET approved = 0')
    await c.api.updateTransaction((await c.api.listTransactions())[0]!.id, { cleared: true })
    expect(await c.api.listUnitEvents(c.brokerage.id)).toEqual([])
    await c.api.approveTransactions([(await c.api.listTransactions())[0]!.id])
    expect(await c.api.listUnitEvents(c.brokerage.id)).toHaveLength(1)
  })

  it('ignores the adjustment a reconciliation posts', async () => {
    const c = await makeApi()
    await c.api.createTransaction({
      accountId: c.brokerage.id,
      date: '2026-10-15',
      payee: 'Reconciliation Balance Adjustment',
      amount: 1_200,
      cleared: true,
    })
    expect(await c.api.listUnitEvents(c.brokerage.id)).toEqual([])
  })
})

describe('moving units between goals', () => {
  it('moves units with their cost and realizes nothing', async () => {
    const c = await makeApi()
    await c.api.recordValuation({
      accountId: c.brokerage.id,
      date: '2026-10-01',
      marketValue: 100_000,
    })
    await contribute(c, 10_000, { date: '2026-10-05' })
    await c.api.recordValuation({
      accountId: c.brokerage.id,
      date: '2026-10-10',
      marketValue: 220_000,
    })
    // opening 1,000 units + 100 for House at $1; now the pool is worth $2 a unit
    await c.api.moveUnits({
      accountId: c.brokerage.id,
      fromGoalId: null,
      toGoalId: c.car.id,
      date: '2026-10-11',
      amount: 100_000,
    })
    expect(await goalRow(c, c.car.id)).toMatchObject({
      units: 500,
      value: 100_000,
      costBasis: 50_000,
      gain: 50_000,
      realized: 0,
    })
    expect(await goalRow(c, null)).toMatchObject({ units: 500, costBasis: 50_000 })
  })

  it('refuses to move more than the goal owns, and can undo a move', async () => {
    const c = await makeApi()
    await contribute(c, 10_000)
    await expect(
      c.api.moveUnits({
        accountId: c.brokerage.id,
        fromGoalId: c.house.id,
        toGoalId: c.car.id,
        date: '2026-10-11',
        amount: 20_000,
      }),
    ).rejects.toThrow(/doesn’t own that much/)
    await c.api.moveUnits({
      accountId: c.brokerage.id,
      fromGoalId: c.house.id,
      toGoalId: c.car.id,
      date: '2026-10-11',
      amount: 4_000,
    })
    const moves = (await c.api.listUnitEvents(c.brokerage.id)).filter((e) => e.source === 'manual')
    expect(moves).toHaveLength(2)
    await c.api.deleteUnitEntry(moves[0]!.id)
    expect(
      (await c.api.listUnitEvents(c.brokerage.id)).filter((e) => e.source === 'manual'),
    ).toEqual([])
    expect(await goalRow(c, c.house.id)).toMatchObject({ units: 100 })
  })

  it('will not delete a row a transaction made', async () => {
    const c = await makeApi()
    await contribute(c, 10_000)
    const [event] = await c.api.listUnitEvents(c.brokerage.id)
    await expect(c.api.deleteUnitEntry(event!.id)).rejects.toThrow(/transaction/)
  })
})

describe('rebuilding from past transfers', () => {
  it('makes the rows for history entered before the ledger and is safe to repeat', async () => {
    const c = await makeApi()
    await contribute(c, 10_000, { date: '2026-09-01' })
    await contribute(c, 20_000, { date: '2026-10-01', goalId: c.car.id })
    await c.adapter.exec('DELETE FROM unit_events')
    expect(await c.api.rebuildUnitLedger(c.brokerage.id)).toEqual({ events: 2 })
    expect(await c.api.rebuildUnitLedger(c.brokerage.id)).toEqual({ events: 2 })
    expect(await goalRow(c, c.house.id)).toMatchObject({ units: 100 })
    expect(await goalRow(c, c.car.id)).toMatchObject({ units: 200 })
  })
})

describe('keeping a goal that owns units', () => {
  it('will not delete a goal with units', async () => {
    const c = await makeApi()
    await contribute(c, 10_000)
    await expect(c.api.deleteGoal(c.house.id)).rejects.toThrow(/history/)
  })
})

describe('holdings mode', () => {
  async function holdingsAccount() {
    const c = await makeApi()
    await c.api.updateInvestmentSettings(c.brokerage.id, { mode: 'holdings' })
    return c
  }

  it('records trades per holding with cost basis, gain and realized gain', async () => {
    const c = await holdingsAccount()
    const vti = await c.api.createHolding({
      accountId: c.brokerage.id,
      name: 'VTI',
      goalId: c.house.id,
      price: 20_000,
    })
    await c.api.recordTrade({
      holdingId: vti.id,
      type: 'buy',
      date: '2026-10-01',
      shares: 10,
      price: 20_000,
    })
    await c.api.recordTrade({
      holdingId: vti.id,
      type: 'buy',
      date: '2026-10-02',
      shares: 10,
      price: 22_000,
    })
    // 20 shares for $4,200, now $230
    await c.api.updateHolding(vti.id, { price: 23_000, priceDate: '2026-10-20' })
    expect(await goalRow(c, c.house.id)).toMatchObject({
      value: 460_000,
      costBasis: 420_000,
      gain: 40_000,
      realized: 0,
    })
    await c.api.recordTrade({
      holdingId: vti.id,
      type: 'sell',
      date: '2026-10-21',
      shares: 5,
      price: 23_000,
    })
    const row = await goalRow(c, c.house.id)
    expect(row).toMatchObject({
      value: 345_000,
      costBasis: 315_000,
      gain: 30_000,
      realized: 10_000,
    })
    expect(row?.holdings[0]).toMatchObject({ name: 'VTI', shares: 15 })
  })

  it('keeps different holdings under different goals and refuses to oversell', async () => {
    const c = await holdingsAccount()
    const vti = await c.api.createHolding({
      accountId: c.brokerage.id,
      name: 'VTI',
      goalId: c.house.id,
    })
    const bnd = await c.api.createHolding({
      accountId: c.brokerage.id,
      name: 'BND',
      goalId: c.car.id,
    })
    await c.api.recordTrade({
      holdingId: vti.id,
      type: 'buy',
      date: '2026-10-01',
      shares: 2,
      price: 10_000,
    })
    await c.api.recordTrade({
      holdingId: bnd.id,
      type: 'buy',
      date: '2026-10-01',
      shares: 4,
      price: 7_500,
    })
    await expect(
      c.api.recordTrade({
        holdingId: bnd.id,
        type: 'sell',
        date: '2026-10-02',
        shares: 5,
        price: 7_500,
      }),
    ).rejects.toThrow(/more shares/)
    const result = await c.api.getAccountInvestments(c.brokerage.id)
    expect(result.goals.map((g) => [g.goalName, g.value])).toEqual([
      ['House', 20_000],
      ['Car', 30_000],
    ])
    expect(result.value).toBe(50_000)
  })

  it('buys the goal’s only priced holding when a contribution clears', async () => {
    const c = await holdingsAccount()
    await c.api.createHolding({
      accountId: c.brokerage.id,
      name: 'VTI',
      goalId: c.house.id,
      price: 25_000,
    })
    await contribute(c, 100_000)
    const row = await goalRow(c, c.house.id)
    expect(row?.holdings[0]).toMatchObject({ shares: 4, value: 100_000, costBasis: 100_000 })
  })

  it('leaves a contribution alone when the goal has no single priced holding', async () => {
    const c = await holdingsAccount()
    await contribute(c, 100_000)
    await c.api.createHolding({
      accountId: c.brokerage.id,
      name: 'A',
      goalId: c.house.id,
      price: 100,
    })
    await c.api.createHolding({
      accountId: c.brokerage.id,
      name: 'B',
      goalId: c.house.id,
      price: 100,
    })
    await contribute(c, 100_000, { date: '2026-10-06' })
    expect(await c.api.listUnitEvents(c.brokerage.id)).toEqual([])
  })

  it('moves a holding’s history with it to another goal, and keeps one with trades', async () => {
    const c = await holdingsAccount()
    const vti = await c.api.createHolding({
      accountId: c.brokerage.id,
      name: 'VTI',
      goalId: c.house.id,
    })
    await c.api.recordTrade({
      holdingId: vti.id,
      type: 'buy',
      date: '2026-10-01',
      shares: 1,
      price: 10_000,
    })
    await c.api.updateHolding(vti.id, { goalId: c.car.id })
    expect(await goalRow(c, c.car.id)).toMatchObject({ value: 10_000 })
    expect(await goalRow(c, c.house.id)).toBeUndefined()
    await expect(c.api.deleteHolding(vti.id)).rejects.toThrow(/trades/)
  })
})

describe('Roth contributions', () => {
  async function roths() {
    const c = await makeApi()
    const { members } = (await c.api.getHousehold())!
    const [matt, jessica] = members as unknown as [{ id: string }, { id: string }]
    const mattRoth = await c.api.createAccount({
      name: 'Matt Roth',
      type: 'investment',
      investment: { kind: 'ira', taxType: 'roth', ownerId: matt.id },
    })
    const jessicaRoth = await c.api.createAccount({
      name: 'Jessica Roth',
      type: 'investment',
      investment: { kind: 'ira', taxType: 'roth', ownerId: jessica.id },
    })
    const put = (to: string, amount: number, date: string, from = c.checking.id) =>
      c.api.createTransfer({ fromAccountId: from, toAccountId: to, date, amount })
    return { ...c, matt, jessica, mattRoth, jessicaRoth, put }
  }

  it('counts each person’s transfers in during the year against the default limit', async () => {
    const r = await roths()
    await r.put(r.mattRoth.id, 300_000, '2026-02-01')
    await r.put(r.mattRoth.id, 200_000, '2026-06-01')
    await r.put(r.jessicaRoth.id, 750_000, '2026-03-01')
    await r.put(r.mattRoth.id, 100_000, '2025-12-31') // last year
    const report = await r.api.getRothContributions(2026)
    expect(report.members).toMatchObject([
      {
        displayName: 'Matt',
        limit: 750_000,
        isDefaultLimit: true,
        contributed: 500_000,
        remaining: 250_000,
        over: false,
      },
      { displayName: 'Jessica', contributed: 750_000, remaining: 0, over: false },
    ])
    expect((await r.api.getRothContributions(2025)).members[0]).toMatchObject({
      contributed: 100_000,
      limit: 700_000,
    })
  })

  it('flags going over, and takes a limit of the household’s own', async () => {
    const r = await roths()
    await r.put(r.mattRoth.id, 800_000, '2026-02-01')
    expect((await r.api.getRothContributions(2026)).members[0]).toMatchObject({
      over: true,
      remaining: -50_000,
    })
    await r.api.setContributionLimit({ memberId: r.matt.id, year: 2026, limit: 850_000 })
    expect((await r.api.getRothContributions(2026)).members[0]).toMatchObject({
      limit: 850_000,
      isDefaultLimit: false,
      over: false,
    })
    await r.api.setContributionLimit({ memberId: r.matt.id, year: 2026, limit: null })
    expect((await r.api.getRothContributions(2026)).members[0]).toMatchObject({
      isDefaultLimit: true,
    })
  })

  it('does not count a conversion from another investment account, or a withdrawal', async () => {
    const r = await roths()
    await r.put(r.mattRoth.id, 400_000, '2026-02-01', r.brokerage.id)
    await r.api.createTransfer({
      fromAccountId: r.mattRoth.id,
      toAccountId: r.checking.id,
      date: '2026-03-01',
      amount: 100_000,
    })
    expect((await r.api.getRothContributions(2026)).members[0]).toMatchObject({ contributed: 0 })
  })

  it('lists a Roth IRA with no owner apart, and leaves out other tax types and kinds', async () => {
    const r = await roths()
    const joint = await r.api.createAccount({
      name: 'Joint Roth',
      type: 'investment',
      investment: { kind: 'ira', taxType: 'roth' },
    })
    await r.api.createAccount({
      name: 'Roth 401k',
      type: 'investment',
      investment: { kind: '401k', taxType: 'roth', ownerId: r.matt.id },
    })
    await r.put(joint.id, 100_000, '2026-02-01')
    const report = await r.api.getRothContributions(2026)
    expect(report.unowned).toEqual([
      { accountId: joint.id, name: 'Joint Roth', contributed: 100_000 },
    ])
    expect(report.members.flatMap((m) => m.accounts.map((a) => a.name))).toEqual([
      'Matt Roth',
      'Jessica Roth',
    ])
  })
})
