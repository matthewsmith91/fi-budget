import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { projectRetirement, realReturnRate } from './retirement.ts'
import { openMemoryAdapter } from './test-utils.ts'

describe('realReturnRate', () => {
  it('takes inflation out of the return', () => {
    expect(realReturnRate(7, 3)).toBeCloseTo(3.883, 3)
    expect(realReturnRate(3, 3)).toBe(0)
  })
})

describe('projectRetirement (pure)', () => {
  it('only adds contributions when the real return is zero', () => {
    const points = projectRetirement({
      start: 10_000_00,
      monthlyContribution: 500_00,
      realReturn: 0,
      months: 24,
      from: '2026-10',
      ageMonths: 35 * 12,
    })
    expect(points.map((p) => [p.month, p.age, p.balance, p.contributed])).toEqual([
      ['2026-10', 35, 10_000_00, 0],
      ['2027-10', 36, 16_000_00, 6_000_00],
      ['2028-10', 37, 22_000_00, 12_000_00],
    ])
  })

  it('compounds monthly, so a year at 12% real is 12% on the start', () => {
    const [first, last] = projectRetirement({
      start: 100_000_00,
      monthlyContribution: 0,
      realReturn: 12,
      months: 12,
      from: '2026-10',
      ageMonths: 0,
    })
    expect(first!.balance).toBe(100_000_00)
    expect(last!.balance).toBeGreaterThanOrEqual(111_999_00)
    expect(last!.balance).toBeLessThanOrEqual(112_001_00)
  })

  it('ends on the target even when it is not a whole year away', () => {
    const points = projectRetirement({
      start: 0,
      monthlyContribution: 100,
      realReturn: 0,
      months: 18,
      from: '2026-10',
      ageMonths: 12 * 40 + 6,
    })
    expect(points.map((p) => [p.month, p.age])).toEqual([
      ['2026-10', 40.5],
      ['2027-10', 41.5],
      ['2028-04', 42],
    ])
  })

  it('has one point when already at the target', () => {
    const points = projectRetirement({
      start: 5,
      monthlyContribution: 100,
      realReturn: 5,
      months: 0,
      from: '2026-10',
      ageMonths: 0,
    })
    expect(points).toHaveLength(1)
  })
})

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
  const roth = await api.createAccount({
    name: 'Roth',
    type: 'investment',
    investment: { kind: 'ira', taxType: 'roth' },
  })
  const k401 = await api.createAccount({
    name: '401k',
    type: 'investment',
    investment: { kind: '401k' },
  })
  const brokerage = await api.createAccount({ name: 'Brokerage', type: 'investment' })
  return { api, adapter, checking, roth, k401, brokerage }
}

describe('retirement settings', () => {
  it('starts with defaults and no birth month, then saves and reads back', async () => {
    const { api } = await makeApi()
    expect(await api.getRetirementSettings()).toEqual({
      birthMonth: null,
      targetAge: 65,
      monthlyContribution: 0,
      returnRate: 7,
      inflationRate: 3,
      withdrawalRate: 4,
      lookbackMonths: 12,
    })
    const settings = {
      birthMonth: '1991-02',
      targetAge: 60,
      monthlyContribution: 1_500_00,
      returnRate: 6.5,
      inflationRate: 2.5,
      withdrawalRate: 4,
      lookbackMonths: 12,
    }
    expect(await api.setRetirementSettings(settings)).toEqual(settings)
    expect(await api.getRetirementSettings()).toEqual(settings)
    // a second save changes the same row
    await api.setRetirementSettings({ ...settings, targetAge: 62 })
    expect((await api.getRetirementSettings()).targetAge).toBe(62)
  })

  it('refuses values that make no sense', async () => {
    const { api } = await makeApi()
    const ok = {
      birthMonth: '1991-02',
      targetAge: 65,
      monthlyContribution: 0,
      returnRate: 7,
      inflationRate: 3,
      withdrawalRate: 4,
      lookbackMonths: 12,
    }
    await expect(api.setRetirementSettings({ ...ok, targetAge: 20 })).rejects.toThrow(/target age/)
    await expect(api.setRetirementSettings({ ...ok, targetAge: 65.5 })).rejects.toThrow(/whole/)
    await expect(api.setRetirementSettings({ ...ok, returnRate: 80 })).rejects.toThrow(/return/)
    await expect(api.setRetirementSettings({ ...ok, inflationRate: NaN })).rejects.toThrow(
      /Inflation/,
    )
    await expect(api.setRetirementSettings({ ...ok, monthlyContribution: -1 })).rejects.toThrow(
      /contribution/,
    )
    await expect(api.setRetirementSettings({ ...ok, birthMonth: '1991-13' })).rejects.toThrow()
  })
})

describe('getRetirementProjection', () => {
  it('asks for a birth month before projecting', async () => {
    const { api } = await makeApi()
    const p = await api.getRetirementProjection({ asOf: '2026-10' })
    expect(p).toMatchObject({ problem: expect.stringMatching(/birth month/), points: [] })
    expect(p.projected).toBeNull()
  })

  it('projects only retirement accounts, from their newest values', async () => {
    const { api, roth, k401, brokerage } = await makeApi()
    await api.recordValuation({ accountId: roth.id, date: '2026-10-01', marketValue: 40_000_00 })
    await api.recordValuation({ accountId: k401.id, date: '2026-09-30', marketValue: 60_000_00 })
    await api.recordValuation({
      accountId: brokerage.id,
      date: '2026-10-01',
      marketValue: 9_999_00,
    })
    await api.setRetirementSettings({
      birthMonth: '1996-10', // 30 on asOf
      targetAge: 40,
      monthlyContribution: 1_000_00,
      returnRate: 3,
      inflationRate: 3, // no real growth, so the math is exact
      withdrawalRate: 4,
      lookbackMonths: 12,
    })
    const p = await api.getRetirementProjection({ asOf: '2026-10' })
    expect(p.problem).toBeNull()
    expect(p.accounts.map((a) => [a.name, a.value])).toEqual([
      ['Roth', 40_000_00],
      ['401k', 60_000_00],
    ])
    expect(p.startingBalance).toBe(100_000_00)
    expect(p.monthsToTarget).toBe(120)
    expect(p.contributed).toBe(120_000_00)
    expect(p.projected).toBe(220_000_00)
    expect(p.growth).toBe(0)
    expect(p.points[0]).toMatchObject({ month: '2026-10', age: 30, balance: 100_000_00 })
    expect(p.points.at(-1)).toMatchObject({ month: '2036-10', age: 40, balance: 220_000_00 })
  })

  it('shows growth when the return beats inflation', async () => {
    const { api, roth } = await makeApi()
    await api.recordValuation({ accountId: roth.id, date: '2026-10-01', marketValue: 10_000_00 })
    await api.setRetirementSettings({
      birthMonth: '1976-10',
      targetAge: 60,
      monthlyContribution: 0,
      returnRate: 8,
      inflationRate: 2,
      withdrawalRate: 4,
      lookbackMonths: 12,
    })
    const p = await api.getRetirementProjection({ asOf: '2026-10' })
    expect(p.monthsToTarget).toBe(120)
    expect(p.projected).toBeGreaterThan(10_000_00 * 1.5)
    expect(p.growth).toBe(p.projected! - 10_000_00)
  })

  it('stays at today’s value when already past the target age, and flags a future birth month', async () => {
    const { api, roth } = await makeApi()
    await api.recordValuation({ accountId: roth.id, date: '2026-10-01', marketValue: 10_000_00 })
    await api.setRetirementSettings({
      birthMonth: '1950-01',
      targetAge: 65,
      monthlyContribution: 500_00,
      returnRate: 7,
      inflationRate: 3,
      withdrawalRate: 4,
      lookbackMonths: 12,
    })
    const done = await api.getRetirementProjection({ asOf: '2026-10' })
    expect(done).toMatchObject({ monthsToTarget: 0, projected: 10_000_00, contributed: 0 })
    expect(done.points).toHaveLength(1)

    await api.setRetirementSettings({
      ...(await api.getRetirementSettings()),
      birthMonth: '2030-01',
    })
    expect((await api.getRetirementProjection({ asOf: '2026-10' })).problem).toMatch(/future/)
  })

  it('leaves out closed accounts and reports what moved into retirement accounts lately', async () => {
    const { api, checking, roth, k401 } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2025-12-01', amount: 20_000_00 })
    for (const date of ['2025-10-15', '2025-11-15', '2026-09-15']) {
      await api.createTransfer({
        fromAccountId: checking.id,
        toAccountId: roth.id,
        date,
        amount: 600_00,
      })
    }
    await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: roth.id,
      date: '2026-10-02',
      amount: 1_200_00,
    })
    await api.recordValuation({ accountId: k401.id, date: '2026-10-01', marketValue: 5_000_00 })
    await api.updateAccount(k401.id, { closed: true })
    const p = await api.getRetirementProjection({ asOf: '2026-10' })
    expect(p.accounts.map((a) => a.name)).toEqual(['Roth'])
    // 2025-10 is outside the 12 months ending 2026-10 (2025-11 .. 2026-10): 600 + 600 + 1200
    expect(p.recentMonthlyContribution).toBe(200_00)
  })
})

describe('category retirement status', () => {
  async function category() {
    const { api } = await makeApi()
    const group = await api.createCategoryGroup({ name: 'Spending' })
    const travel = await api.createCategory({ groupId: group.id, name: 'Travel' })
    return { api, travel }
  }

  it('continues by default, with no multiplier', async () => {
    const { travel } = await category()
    expect(travel).toMatchObject({ retirementStatus: 'continues', retirementMultiplier: null })
  })

  it('keeps a multiplier only while the status is changes', async () => {
    const { api, travel } = await category()
    expect(
      await api.updateCategory(travel.id, {
        retirementStatus: 'changes',
        retirementMultiplier: 1.5,
      }),
    ).toMatchObject({ retirementStatus: 'changes', retirementMultiplier: 1.5 })
    // other edits leave it alone
    expect(await api.updateCategory(travel.id, { needOrWant: 'need' })).toMatchObject({
      retirementStatus: 'changes',
      retirementMultiplier: 1.5,
    })
    expect(await api.updateCategory(travel.id, { retirementMultiplier: 0.75 })).toMatchObject({
      retirementMultiplier: 0.75,
    })
    expect(await api.updateCategory(travel.id, { retirementStatus: 'ends' })).toMatchObject({
      retirementStatus: 'ends',
      retirementMultiplier: null,
    })
  })

  it('needs a sensible multiplier for changes', async () => {
    const { api, travel } = await category()
    await expect(api.updateCategory(travel.id, { retirementStatus: 'changes' })).rejects.toThrow(
      /multiplied/,
    )
    for (const retirementMultiplier of [0, -1, 11, NaN]) {
      await expect(
        api.updateCategory(travel.id, { retirementStatus: 'changes', retirementMultiplier }),
      ).rejects.toThrow(/multiplier/)
    }
    await expect(
      api.updateCategory(travel.id, { retirementStatus: 'sometimes' as never }),
    ).rejects.toThrow(/Unknown retirement status/)
  })

  it('rounds the multiplier to two decimals', async () => {
    const { api, travel } = await category()
    const c = await api.updateCategory(travel.id, {
      retirementStatus: 'changes',
      retirementMultiplier: 1.236,
    })
    expect(c.retirementMultiplier).toBe(1.24)
  })

  it('does not apply to a credit card payment category', async () => {
    const { api } = await makeApi()
    const visa = await api.createAccount({ name: 'Visa', type: 'credit' })
    const payment = (await api.listCategoryGroups())
      .flatMap((g) => g.categories)
      .find((c) => c.creditCardAccountId === visa.id)!
    await expect(api.updateCategory(payment.id, { retirementStatus: 'ends' })).rejects.toThrow(
      /isn’t spending/,
    )
  })
})
