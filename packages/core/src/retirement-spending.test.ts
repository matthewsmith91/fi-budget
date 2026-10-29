import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { itemActiveAt, spendSchedule } from './retirement-spending.ts'
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
  const group = await api.createCategoryGroup({ name: 'Spending' })
  const rent = await api.createCategory({ groupId: group.id, name: 'Rent' })
  const travel = await api.createCategory({ groupId: group.id, name: 'Travel' })
  const college = await api.createCategory({ groupId: group.id, name: 'College savings' })
  await api.updateCategory(travel.id, { retirementStatus: 'changes', retirementMultiplier: 1.5 })
  await api.updateCategory(college.id, { retirementStatus: 'ends' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  await api.createTransaction({ accountId: checking.id, date: '2026-01-01', amount: 5_000_000 })
  const k401 = await api.createAccount({
    name: '401k',
    type: 'investment',
    investment: { kind: '401k' },
  })
  const spend = (date: string, categoryId: string, amount: number) =>
    api.createTransaction({ accountId: checking.id, date, categoryId, amount: -amount })
  // three months of the same spending, July to September
  for (const date of ['2026-07-05', '2026-08-05', '2026-09-05']) {
    await spend(date, rent.id, 200_000)
    await spend(date, travel.id, 40_000)
    await spend(date, college.id, 50_000)
  }
  const settings = { ...(await api.getRetirementSettings()), birthMonth: '1961-10' }
  await api.setRetirementSettings(settings)
  return { api, rent, travel, college, k401, spend, checking, settings }
}

const ASOF = { month: '2026-09', asOf: '2026-10' }

describe('itemActiveAt', () => {
  it('applies from the start age up to, not including, the end age', () => {
    const item = { startAge: 60, endAge: 65 }
    expect([59, 60, 64, 65].map((age) => itemActiveAt(item, age))).toEqual([
      false,
      true,
      true,
      false,
    ])
    expect(itemActiveAt({ startAge: null, endAge: null }, 0)).toBe(true)
    expect(itemActiveAt({ startAge: null, endAge: 65 }, 40)).toBe(true)
    expect(itemActiveAt({ startAge: 70, endAge: null }, 99)).toBe(true)
  })
})

describe('spendSchedule (pure)', () => {
  const insurance = { annualAmount: 1_200_000, startAge: null, endAge: 65 }
  const upkeep = { annualAmount: 240_000, startAge: 60, endAge: null }

  it('steps wherever a fixed item starts or stops', () => {
    expect(spendSchedule(3_120_000, [insurance, upkeep], 55)).toEqual([
      { fromAge: 55, toAge: 60, annual: 4_320_000 },
      { fromAge: 60, toAge: 65, annual: 4_560_000 },
      { fromAge: 65, toAge: null, annual: 3_360_000 },
    ])
  })

  it('ignores steps before retirement and joins steps that spend the same', () => {
    expect(spendSchedule(1_000, [insurance, upkeep], 66)).toEqual([
      { fromAge: 66, toAge: null, annual: 241_000 },
    ])
    // one item ends the year another starts: no step in between
    const swap = [
      { annualAmount: 500, startAge: null, endAge: 70 },
      { annualAmount: 500, startAge: 70, endAge: null },
    ]
    expect(spendSchedule(0, swap, 65)).toEqual([{ fromAge: 65, toAge: null, annual: 500 }])
  })
})

describe('retirement fixed items', () => {
  it('creates, lists, updates and deletes', async () => {
    const { api } = await makeApi()
    const item = await api.createRetirementFixedItem({
      name: ' Health insurance ',
      annualAmount: 1_200_000,
      endAge: 65,
    })
    expect(item).toMatchObject({
      name: 'Health insurance',
      annualAmount: 1_200_000,
      startAge: null,
      endAge: 65,
    })
    const changed = await api.updateRetirementFixedItem(item.id, { startAge: 60, endAge: null })
    expect(changed).toMatchObject({ startAge: 60, endAge: null })
    expect(await api.listRetirementFixedItems()).toEqual([changed])
    await api.deleteRetirementFixedItem(item.id)
    expect(await api.listRetirementFixedItems()).toEqual([])
    await expect(api.deleteRetirementFixedItem(item.id)).rejects.toThrow(/not found/)
  })

  it('refuses amounts and ages that make no sense', async () => {
    const { api } = await makeApi()
    const ok = { name: 'Care', annualAmount: 100_000 }
    await expect(api.createRetirementFixedItem({ ...ok, annualAmount: 0 })).rejects.toThrow(
      /more than zero/,
    )
    await expect(api.createRetirementFixedItem({ ...ok, annualAmount: 10.5 })).rejects.toThrow(
      /whole number/,
    )
    await expect(api.createRetirementFixedItem({ ...ok, startAge: 130 })).rejects.toThrow(
      /start age/,
    )
    await expect(api.createRetirementFixedItem({ ...ok, endAge: 60.5 })).rejects.toThrow(/end age/)
    await expect(
      api.createRetirementFixedItem({ ...ok, startAge: 65, endAge: 65 }),
    ).rejects.toThrow(/after the start/)
    await expect(api.createRetirementFixedItem({ ...ok, name: ' ' })).rejects.toThrow(
      /name is required/,
    )
    const item = await api.createRetirementFixedItem({ ...ok, startAge: 60 })
    await expect(api.updateRetirementFixedItem(item.id, { endAge: 55 })).rejects.toThrow(
      /after the start/,
    )
  })
})

describe('getRetirementSpending', () => {
  it('builds the baseline from real spending, scaled by each category’s status', async () => {
    const { api } = await makeApi()
    const s = await api.getRetirementSpending(ASOF)
    expect(s.averagedMonths).toBe(3)
    expect(
      s.categories.map((c) => [c.name, c.status, c.monthly, c.retirementMonthly, c.multiplier]),
    ).toEqual([
      ['Rent', 'continues', 200_000, 200_000, null],
      ['Travel', 'changes', 40_000, 60_000, 1.5],
      ['College savings', 'ends', 50_000, 0, null],
    ])
    expect(s.baselineMonthly).toBe(260_000)
    expect(s.endingMonthly).toBe(50_000)
    expect(s.annualSpend).toBe(3_120_000)
    // 4% rule: 25 years of spending
    expect(s.requiredPortfolio).toBe(78_000_000)
    expect(s.categories[0]!.required).toBe(60_000_000)
    expect(s.perHundredMonthly).toBe(3_000_000)
  })

  it('averages over the months it has when the history is short, and over the lookback when not', async () => {
    const { api, rent, spend, settings } = await makeApi()
    await spend('2026-05-05', rent.id, 600_000)
    // the 12-month default reaches back to May: 600,000 + 3 × 200,000 over 5 months
    const long = await api.getRetirementSpending(ASOF)
    expect(long.averagedMonths).toBe(5)
    expect(long.categories.find((c) => c.name === 'Rent')!.monthly).toBe(240_000)
    await api.setRetirementSettings({ ...settings, lookbackMonths: 3 })
    const short = await api.getRetirementSpending(ASOF)
    expect(short.averagedMonths).toBe(3)
    expect(short.categories.find((c) => c.name === 'Rent')!.monthly).toBe(200_000)
  })

  it('counts a refund against the category and drops a category that nets to nothing', async () => {
    const { api, rent, travel, checking } = await makeApi()
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-09-20',
      categoryId: travel.id,
      amount: 120_000,
    })
    const s = await api.getRetirementSpending(ASOF)
    expect(s.categories.find((c) => c.categoryId === travel.id)).toBeUndefined()
    expect(s.categories.find((c) => c.categoryId === rent.id)!.monthly).toBe(200_000)
  })

  it('adds the fixed items that apply at the target age', async () => {
    const { api } = await makeApi()
    await api.createRetirementFixedItem({
      name: 'Health insurance',
      annualAmount: 1_200_000,
      endAge: 65,
    })
    await api.createRetirementFixedItem({
      name: 'Home upkeep',
      annualAmount: 240_000,
      startAge: 60,
    })
    const s = await api.getRetirementSpending(ASOF)
    expect(s.fixedItems.map((i) => [i.name, i.active])).toEqual([
      ['Health insurance', false],
      ['Home upkeep', true],
    ])
    expect(s.fixedAnnual).toBe(240_000)
    expect(s.annualSpend).toBe(3_360_000)
    expect(s.requiredPortfolio).toBe(84_000_000)
    expect(s.schedule).toEqual([{ fromAge: 65, toAge: null, annual: 3_360_000 }])

    // retiring earlier makes the insurance part of the first years
    const settings = await api.getRetirementSettings()
    await api.setRetirementSettings({ ...settings, targetAge: 62 })
    const early = await api.getRetirementSpending(ASOF)
    expect(early.fixedAnnual).toBe(1_440_000)
    expect(early.schedule).toEqual([
      { fromAge: 62, toAge: 65, annual: 4_560_000 },
      { fromAge: 65, toAge: null, annual: 3_360_000 },
    ])
  })

  it('scales the required portfolio with the withdrawal rate', async () => {
    const { api, settings } = await makeApi()
    await api.setRetirementSettings({ ...settings, withdrawalRate: 5 })
    const s = await api.getRetirementSpending(ASOF)
    expect(s.requiredPortfolio).toBe(62_400_000)
    expect(s.perHundredMonthly).toBe(2_400_000)
  })

  it('compares the projected portfolio with what is required', async () => {
    const { api, k401 } = await makeApi()
    // born 1961-10, so the target age of 65 is already here: the projection is today's value
    await api.recordValuation({ accountId: k401.id, date: '2026-10-01', marketValue: 90_000_000 })
    const enough = await api.getRetirementSpending(ASOF)
    expect(enough).toMatchObject({
      projected: 90_000_000,
      requiredPortfolio: 78_000_000,
      surplus: 12_000_000,
      fundedPercent: 115,
      succeeds: true,
    })
    await api.recordValuation({ accountId: k401.id, date: '2026-10-02', marketValue: 39_000_000 })
    const short = await api.getRetirementSpending(ASOF)
    expect(short).toMatchObject({ surplus: -39_000_000, fundedPercent: 50, succeeds: false })
  })

  it('says why it cannot compare without a birth month, or without any spending', async () => {
    const { api, settings } = await makeApi()
    await api.setRetirementSettings({ ...settings, birthMonth: null })
    const s = await api.getRetirementSpending(ASOF)
    expect(s.projected).toBeNull()
    expect(s.projectionProblem).toMatch(/birth month/)
    expect(s.succeeds).toBeNull()
    expect(s.requiredPortfolio).toBe(78_000_000)

    const empty = await api.getRetirementSpending({ month: '2026-01', asOf: '2026-10' })
    expect(empty).toMatchObject({ averagedMonths: 0, annualSpend: 0, requiredPortfolio: null })
    expect(empty.categories).toEqual([])
  })

  it('validates the new assumptions', async () => {
    const { api, settings } = await makeApi()
    await expect(api.setRetirementSettings({ ...settings, withdrawalRate: 0 })).rejects.toThrow(
      /withdrawal rate/,
    )
    await expect(api.setRetirementSettings({ ...settings, withdrawalRate: 11 })).rejects.toThrow(
      /withdrawal rate/,
    )
    await expect(api.setRetirementSettings({ ...settings, lookbackMonths: 2 })).rejects.toThrow(
      /lookback/,
    )
    await expect(api.setRetirementSettings({ ...settings, lookbackMonths: 12.5 })).rejects.toThrow(
      /whole number/,
    )
  })
})
