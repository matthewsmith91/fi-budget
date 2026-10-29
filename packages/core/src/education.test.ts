import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { monthlyNeededFor } from './education.ts'
import { projectRetirement, realReturnRate } from './retirement.ts'
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
  const plan529 = await api.createAccount({
    name: '529',
    type: 'investment',
    investment: { kind: '529', taxType: '529' },
  })
  await api.createCategoryGroup({ name: 'Savings' })
  const [group] = await api.listCategoryGroups()
  const kids = await api.createCategory({ groupId: group!.id, name: 'Kids' })
  const emma = await api.createGoal({ categoryId: kids.id, name: 'Emma', targetAmount: 1_000_000 })
  const noah = await api.createGoal({ categoryId: kids.id, name: 'Noah', targetAmount: 1_000_000 })
  return { api, checking, plan529, kids, emma, noah }
}

const dollars = (n: number) => n * 100

describe('monthlyNeededFor (pure)', () => {
  it('spreads the gap evenly when nothing grows', () => {
    expect(monthlyNeededFor({ start: 0, target: 1_200_000, realReturn: 0, months: 12 })).toBe(
      100_000,
    )
    expect(monthlyNeededFor({ start: 600_000, target: 1_200_000, realReturn: 0, months: 12 })).toBe(
      50_000,
    )
  })

  it('needs nothing when the balance alone grows to the target, or the date is here', () => {
    expect(
      monthlyNeededFor({ start: 1_000_000, target: 1_200_000, realReturn: 5, months: 60 }),
    ).toBe(0)
    expect(monthlyNeededFor({ start: 0, target: 1_200_000, realReturn: 5, months: 0 })).toBe(0)
  })

  it('agrees with the projection: that contribution reaches the target, a cent less does not', () => {
    const input = { start: dollars(5_000), target: dollars(60_000), realReturn: 2, months: 120 }
    const needed = monthlyNeededFor(input)
    const reach = (monthlyContribution: number) =>
      projectRetirement({
        start: input.start,
        monthlyContribution,
        realReturn: input.realReturn,
        months: input.months,
        from: '2026-10',
        ageMonths: 0,
      }).at(-1)!.balance
    expect(reach(needed)).toBeGreaterThanOrEqual(input.target - 1)
    expect(reach(needed - 1)).toBeLessThan(input.target)
  })
})

describe('education plans', () => {
  it('creates with the defaults, lists, updates and deletes', async () => {
    const { api, plan529 } = await makeApi()
    const plan = await api.createEducationPlan({
      name: ' Emma ',
      accountId: plan529.id,
      targetAmount: dollars(80_000),
      targetMonth: '2036-08',
    })
    expect(plan).toMatchObject({
      name: 'Emma',
      accountId: plan529.id,
      goalId: null,
      monthlyContribution: 0,
      returnRate: 6,
      inflationRate: 4,
    })
    const changed = await api.updateEducationPlan(plan.id, { monthlyContribution: dollars(300) })
    expect(changed.monthlyContribution).toBe(30_000)
    expect(await api.listEducationPlans()).toEqual([changed])
    await api.deleteEducationPlan(plan.id)
    expect(await api.listEducationPlans()).toEqual([])
  })

  it('refuses plans that make no sense', async () => {
    const { api, checking, plan529, emma } = await makeApi()
    const ok = { name: 'Emma', targetAmount: dollars(80_000), targetMonth: '2036-08' }
    await expect(api.createEducationPlan({ ...ok, name: '' })).rejects.toThrow(/name is required/)
    await expect(api.createEducationPlan({ ...ok, targetAmount: 0 })).rejects.toThrow(
      /more than zero/,
    )
    await expect(api.createEducationPlan({ ...ok, targetMonth: '2036' })).rejects.toThrow(
      /not a month/,
    )
    await expect(api.createEducationPlan({ ...ok, monthlyContribution: -1 })).rejects.toThrow(
      /contribution/,
    )
    await expect(api.createEducationPlan({ ...ok, returnRate: 99 })).rejects.toThrow(/return/)
    await expect(api.createEducationPlan({ ...ok, inflationRate: NaN })).rejects.toThrow(
      /cost increase/,
    )
    await expect(api.createEducationPlan({ ...ok, accountId: checking.id })).rejects.toThrow(
      /investment account/,
    )
    await expect(api.createEducationPlan({ ...ok, goalId: emma.id })).rejects.toThrow(
      /account that holds/,
    )
    await expect(
      api.createEducationPlan({ ...ok, accountId: plan529.id, goalId: 'nope' }),
    ).rejects.toThrow(/Goal not found/)
  })

  it('drops the goal when the plan moves to another account', async () => {
    const { api, plan529, emma } = await makeApi()
    const other = await api.createAccount({ name: 'Other 529', type: 'investment' })
    const plan = await api.createEducationPlan({
      name: 'Emma',
      accountId: plan529.id,
      goalId: emma.id,
      targetAmount: dollars(80_000),
      targetMonth: '2036-08',
    })
    expect((await api.updateEducationPlan(plan.id, { accountId: other.id })).goalId).toBeNull()
  })

  it('unlinks a plan from an account or goal that is deleted', async () => {
    const { api, plan529, noah } = await makeApi()
    const plan = await api.createEducationPlan({
      name: 'Noah',
      accountId: plan529.id,
      goalId: noah.id,
      targetAmount: dollars(80_000),
      targetMonth: '2038-08',
    })
    await api.deleteGoal(noah.id)
    expect(await api.listEducationPlans()).toEqual([
      expect.objectContaining({ id: plan.id, goalId: null, accountId: plan529.id }),
    ])
    await api.deleteAccount(plan529.id)
    expect(await api.listEducationPlans()).toEqual([
      expect.objectContaining({ accountId: null, goalId: null }),
    ])
  })
})

describe('getEducationProjections', () => {
  it('grows the account value at the return after cost increases, in today’s prices', async () => {
    const { api, plan529 } = await makeApi()
    await api.recordValuation({
      accountId: plan529.id,
      date: '2026-10-01',
      marketValue: dollars(10_000),
    })
    await api.createEducationPlan({
      name: 'Emma',
      accountId: plan529.id,
      targetAmount: dollars(80_000),
      targetMonth: '2036-10',
      monthlyContribution: dollars(200),
    })
    const [p] = await api.getEducationProjections({ asOf: '2026-10' })
    const expected = projectRetirement({
      start: dollars(10_000),
      monthlyContribution: dollars(200),
      realReturn: realReturnRate(6, 4),
      months: 120,
      from: '2026-10',
      ageMonths: 0,
    })
    expect(p!.startingBalance).toBe(dollars(10_000))
    expect(p!.monthsToTarget).toBe(120)
    expect(p!.projected).toBe(expected.at(-1)!.balance)
    expect(p!.points.map((x) => x.month)).toEqual(expected.map((x) => x.month))
    expect(p!.points.at(-1)).toMatchObject({ month: '2036-10', contributed: dollars(200) * 120 })
    expect(p!.gap).toBe(p!.projected - dollars(80_000))
    expect(p!.onTrack).toBe(false)
    expect(p!.percentFunded).toBe(Math.floor((p!.projected * 100) / dollars(80_000)))
    // contributing the suggested amount instead gets there
    expect(p!.monthlyNeeded).toBeGreaterThan(dollars(200))
    await api.updateEducationPlan(p!.plan.id, { monthlyContribution: p!.monthlyNeeded })
    const [fixed] = await api.getEducationProjections({ asOf: '2026-10' })
    expect(fixed!.onTrack).toBe(true)
  })

  it('counts nothing for a plan with no account, and ends at once when the date has passed', async () => {
    const { api } = await makeApi()
    await api.createEducationPlan({
      name: 'Emma',
      targetAmount: dollars(80_000),
      targetMonth: '2026-01',
      monthlyContribution: dollars(200),
    })
    const [p] = await api.getEducationProjections({ asOf: '2026-10' })
    expect(p).toMatchObject({ startingBalance: 0, monthsToTarget: 0, projected: 0, onTrack: false })
    expect(p!.points).toHaveLength(1)
    expect(p!.monthlyNeeded).toBe(0)
  })

  it('counts only a child’s own goal when the plan names one', async () => {
    const { api, checking, plan529, kids, emma, noah } = await makeApi()
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-01',
      amount: dollars(20_000),
    })
    const put = (goalId: string, amount: number, date: string) =>
      api.createTransfer({
        fromAccountId: checking.id,
        toAccountId: plan529.id,
        date,
        amount,
        categoryId: kids.id,
        goalId,
        cleared: true,
      })
    await put(emma.id, dollars(6_000), '2026-05-01')
    await put(noah.id, dollars(4_000), '2026-06-01')
    // the account has gained 10%: 11,000 where 10,000 went in
    await api.recordValuation({
      accountId: plan529.id,
      date: '2026-10-01',
      marketValue: dollars(11_000),
    })
    const plan = (goalId: string | null) =>
      api.createEducationPlan({
        name: goalId === emma.id ? 'Emma' : goalId === noah.id ? 'Noah' : 'Both',
        accountId: plan529.id,
        goalId,
        targetAmount: dollars(80_000),
        targetMonth: '2036-10',
      })
    await plan(emma.id)
    await plan(noah.id)
    await plan(null)
    const projections = await api.getEducationProjections({ asOf: '2026-10' })
    expect(projections.map((p) => [p.plan.name, p.startingBalance])).toEqual([
      ['Emma', dollars(6_600)],
      ['Noah', dollars(4_400)],
      ['Both', dollars(11_000)],
    ])
  })
})
