import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { suggestMoves } from './monthly-review.ts'
import { openMemoryAdapter } from './test-utils.ts'

const MONTH = '2026-10'

/** A budget with `income` to hand out, then 270,000 assigned and some of it spent. */
async function makeApi(income: number) {
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
  await api.createTransaction({ accountId: checking.id, date: '2026-10-01', amount: income })
  const group = await api.createCategoryGroup({ name: 'Spending' })
  const cat = (name: string, needOrWant: 'need' | 'want') =>
    api.createCategory({ groupId: group.id, name, needOrWant })
  const groceries = await cat('Groceries', 'need')
  const fun = await cat('Fun', 'want')
  const dining = await cat('Dining', 'want')
  const emergency = await cat('Emergency Fund', 'need')
  const savings = await cat('Savings', 'want')
  const laptop = await api.createGoal({
    categoryId: savings.id,
    name: 'Laptop',
    targetAmount: 120_000,
    targetDate: '2026-12-31',
  })
  const assign = (categoryId: string, amount: number, goalId?: string) =>
    api.allocate({ month: MONTH, categoryId, amount, goalId })
  const spend = (categoryId: string, amount: number) =>
    api.createTransaction({
      accountId: checking.id,
      date: '2026-10-10',
      categoryId,
      amount: -amount,
    })
  return { api, checking, groceries, fun, dining, emergency, savings, laptop, assign, spend }
}

describe('suggestMoves (pure)', () => {
  const over = (categoryId: string, amount: number) => ({ categoryId, name: categoryId, amount })
  const donor = (categoryId: string, spare: number, tag: 'need' | 'want' = 'want') => ({
    categoryId,
    name: categoryId,
    spare,
    tag,
  })

  it('covers overspending from Ready to Assign first, then from donors, wants before needs', () => {
    const { suggestions, uncovered } = suggestMoves({
      ready: 10_000,
      overspent: [over('a', 50_000)],
      underfunded: [],
      donors: [
        donor('need-big', 90_000, 'need'),
        donor('want-small', 15_000),
        donor('want-big', 20_000),
      ],
    })
    expect(suggestions.map((s) => [s.fromCategoryId, s.toCategoryId, s.amount])).toEqual([
      [null, 'a', 10_000],
      ['want-big', 'a', 20_000],
      ['want-small', 'a', 15_000],
      ['need-big', 'a', 5_000],
    ])
    expect(uncovered).toBe(0)
  })

  it('reports what it cannot cover, and never takes the same money twice', () => {
    const { suggestions, uncovered } = suggestMoves({
      ready: 0,
      overspent: [over('a', 30_000), over('b', 20_000)],
      underfunded: [],
      donors: [donor('x', 35_000)],
    })
    expect(suggestions.map((s) => [s.toCategoryId, s.amount])).toEqual([
      ['a', 30_000],
      ['b', 5_000],
    ])
    expect(uncovered).toBe(15_000)
  })

  it('gives underfunded goals only what Ready to Assign has left, the neediest first', () => {
    const goal = (goalId: string, shortBy: number) => ({
      goalId,
      categoryId: 'savings',
      name: goalId,
      categoryName: 'Savings',
      monthlyNeeded: shortBy,
      shortBy,
      percentFunded: 0,
    })
    const { suggestions } = suggestMoves({
      ready: 60_000,
      overspent: [over('a', 10_000)],
      underfunded: [goal('small', 20_000), goal('big', 40_000)],
      donors: [donor('x', 99_000)],
    })
    expect(suggestions.map((s) => [s.reason, s.toGoalId, s.amount])).toEqual([
      ['overspent', null, 10_000],
      ['underfunded', 'big', 40_000],
      ['underfunded', 'small', 10_000],
    ])
  })

  it('suggests nothing when nothing is wrong or nothing is spare', () => {
    expect(suggestMoves({ ready: -500, overspent: [], underfunded: [], donors: [] })).toEqual({
      suggestions: [],
      uncovered: 0,
    })
    expect(
      suggestMoves({
        ready: 0,
        overspent: [over('a', 100)],
        underfunded: [],
        donors: [donor('x', 0)],
      }),
    ).toEqual({ suggestions: [], uncovered: 100 })
  })
})

describe('getMonthlyReview', () => {
  /** Groceries goes 30,000 over; Fun has 40,000 and Dining 30,000 left unspent. */
  async function overspentBudget(income: number) {
    const c = await makeApi(income)
    await c.assign(c.groceries.id, 100_000)
    await c.assign(c.fun.id, 60_000)
    await c.assign(c.dining.id, 30_000)
    await c.assign(c.emergency.id, 80_000)
    await c.spend(c.groceries.id, 130_000)
    await c.spend(c.fun.id, 20_000)
    return c
  }

  it('names what went over and what is underfunded', async () => {
    const { api, groceries, laptop } = await overspentBudget(310_000)
    const review = await api.getMonthlyReview({ month: MONTH })
    expect(review.overspent).toEqual([
      { categoryId: groceries.id, name: 'Groceries', amount: 30_000 },
    ])
    // 120,000 over October, November and December
    expect(review.underfunded).toEqual([
      {
        goalId: laptop.id,
        categoryId: expect.any(String),
        name: 'Laptop',
        categoryName: 'Savings',
        monthlyNeeded: 40_000,
        shortBy: 40_000,
        percentFunded: 0,
      },
    ])
    expect(review).toMatchObject({
      month: MONTH,
      readyToAssign: 40_000,
      assigned: 270_000,
      spent: 150_000,
    })
    expect(review.emergencyFund).toBeNull()
  })

  it('covers the overspending from Ready to Assign, then funds the goal with what is left', async () => {
    const { api, groceries, savings, laptop } = await overspentBudget(310_000)
    const review = await api.getMonthlyReview({ month: MONTH })
    expect(review.suggestions).toEqual([
      {
        reason: 'overspent',
        fromCategoryId: null,
        fromName: 'Ready to Assign',
        toCategoryId: groceries.id,
        toGoalId: null,
        toName: 'Groceries',
        amount: 30_000,
      },
      {
        reason: 'underfunded',
        fromCategoryId: null,
        fromName: 'Ready to Assign',
        toCategoryId: savings.id,
        toGoalId: laptop.id,
        toName: 'Savings: Laptop',
        amount: 10_000,
      },
    ])
    expect(review.uncovered).toBe(0)
  })

  it('takes the rest from wants, but never from the emergency fund', async () => {
    const { api, groceries, fun, emergency } = await overspentBudget(270_000)
    await api.setEmergencyFund({ categoryId: emergency.id, months: 6, window: 12 })
    const review = await api.getMonthlyReview({ month: MONTH })
    expect(review.readyToAssign).toBe(0)
    expect(review.suggestions).toEqual([
      expect.objectContaining({
        reason: 'overspent',
        fromCategoryId: fun.id,
        toCategoryId: groceries.id,
        amount: 30_000,
      }),
    ])
    expect(review.emergencyFund?.settings.categoryId).toBe(emergency.id)
  })

  it('applying a suggestion clears the overspending', async () => {
    const { api, groceries } = await overspentBudget(270_000)
    const [first] = (await api.getMonthlyReview({ month: MONTH })).suggestions
    await api.moveAllocation({
      month: MONTH,
      fromCategoryId: first!.fromCategoryId!,
      toCategoryId: first!.toCategoryId,
      amount: first!.amount,
    })
    const after = await api.getMonthlyReview({ month: MONTH })
    expect(after.overspent).toEqual([])
    expect(
      (await api.getMonthBalances(MONTH)).find((b) => b.categoryId === groceries.id)!.available,
    ).toBe(0)
  })

  it('leaves a category’s goal money alone', async () => {
    const { api, assign, groceries, fun, dining, savings, laptop, spend } = await makeApi(70_000)
    await assign(groceries.id, 10_000)
    await spend(groceries.id, 40_000)
    await assign(fun.id, 5_000)
    await assign(dining.id, 5_000)
    // Savings holds 50,000, all of it in the laptop goal
    await assign(savings.id, 50_000, laptop.id)
    const review = await api.getMonthlyReview({ month: MONTH })
    expect(review.readyToAssign).toBe(0)
    expect(review.suggestions.map((s) => s.fromCategoryId).sort()).toEqual(
      [dining.id, fun.id].sort(),
    )
    expect(review.uncovered).toBe(20_000)
  })

  it('warns about an account whose goals hold more than it does', async () => {
    const { api, checking, savings, laptop, assign } = await makeApi(300_000)
    await api.updateGoal(laptop.id, { heldInAccountId: checking.id })
    await assign(savings.id, 400_000, laptop.id)
    const review = await api.getMonthlyReview({ month: MONTH })
    expect(review.overAllocated).toEqual([
      expect.objectContaining({
        accountId: checking.id,
        name: 'Checking',
        balance: 300_000,
        held: 400_000,
        over: 100_000,
      }),
    ])
  })

  it('has nothing to say about a quiet month', async () => {
    const { api, laptop } = await makeApi(100_000)
    const review = await api.getMonthlyReview({ month: MONTH })
    expect(review).toMatchObject({ overspent: [], uncovered: 0, overAllocated: [] })
    // the one thing to do is fund the laptop goal from the unassigned money
    expect(review.suggestions).toEqual([
      expect.objectContaining({ reason: 'underfunded', toGoalId: laptop.id, amount: 40_000 }),
    ])
    await expect(api.getMonthlyReview({ month: '2026' })).rejects.toThrow(/not a month/)
  })
})
