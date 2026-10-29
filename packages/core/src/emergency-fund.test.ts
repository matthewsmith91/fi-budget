import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { emergencyFundFigures } from './emergency-fund.ts'
import { MIGRATIONS, migrate } from './migrations.ts'
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
  await api.createHousehold({ name: 'Smiths', members: ['Matt', 'Jessica'] })
  const group = await api.createCategoryGroup({ name: 'Spending' })
  const rent = await api.createCategory({ groupId: group.id, name: 'Rent', needOrWant: 'need' })
  const fun = await api.createCategory({ groupId: group.id, name: 'Fun', needOrWant: 'want' })
  const fund = await api.createCategory({ groupId: group.id, name: 'Emergency Fund' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  await api.createTransaction({ accountId: checking.id, date: '2026-01-01', amount: 5_000_000 })
  const spend = (date: string, categoryId: string, amount: number) =>
    api.createTransaction({ accountId: checking.id, date, categoryId, amount: -amount })
  return { api, adapter, group, rent, fun, fund, spend }
}

describe('emergencyFundFigures (pure)', () => {
  const settings = { categoryId: 'c', months: 6, window: 12 }

  it('sizes the target as months of coverage times the average Need month', () => {
    const f = emergencyFundFigures(settings, 450_000, { need: 200_000, months: 12 })
    expect(f.target).toBe(1_200_000)
    expect(f.shortfall).toBe(750_000)
    expect(f.monthsCovered).toBe(2.2)
  })

  it('rounds months covered down so it never overstates', () => {
    expect(
      emergencyFundFigures(settings, 299_999, { need: 100_000, months: 3 }).monthsCovered,
    ).toBe(2.9)
  })

  it('has no shortfall once the target is met', () => {
    const f = emergencyFundFigures(settings, 1_300_000, { need: 200_000, months: 12 })
    expect(f.shortfall).toBe(0)
    expect(f.monthsCovered).toBe(6.5)
  })

  it('has nothing to measure against without Need spending, and never goes below zero months', () => {
    expect(emergencyFundFigures(settings, 50_000, { need: 0, months: 0 }).monthsCovered).toBeNull()
    expect(
      emergencyFundFigures(settings, -50_000, { need: 100_000, months: 3 }).monthsCovered,
    ).toBe(0)
  })
})

describe('getEmergencyFund', () => {
  it('starts with the default settings and no category', async () => {
    const { api } = await makeApi()
    const f = await api.getEmergencyFund({ asOf: '2026-10' })
    expect(f.settings).toEqual({ categoryId: null, months: 6, window: 12 })
    expect(f.balance).toBe(0)
    expect(f.target).toBe(0)
    expect(f.monthsCovered).toBeNull()
  })

  it('measures the category against the average Need month, ignoring wants', async () => {
    const { api, rent, fun, fund, spend } = await makeApi()
    for (const date of ['2026-07-05', '2026-08-05', '2026-09-05']) {
      await spend(date, rent.id, 200_000)
      await spend(date, fun.id, 50_000)
    }
    await api.allocate({
      month: '2026-09',
      categoryId: fund.id,
      amount: 300_000,
    })
    await api.setEmergencyFund({ categoryId: fund.id, months: 6, window: 3 })

    const f = await api.getEmergencyFund({ asOf: '2026-10', month: '2026-09' })
    expect(f.averageNeed).toBe(200_000)
    expect(f.averagedMonths).toBe(3)
    expect(f.target).toBe(1_200_000)
    expect(f.balance).toBe(300_000)
    expect(f.shortfall).toBe(900_000)
    expect(f.monthsCovered).toBe(1.5)
  })

  it('takes the balance as of asOf but the average through month', async () => {
    const { api, rent, fund, spend } = await makeApi()
    await spend('2026-09-05', rent.id, 100_000)
    await spend('2026-10-05', rent.id, 900_000)
    await api.allocate({
      month: '2026-10',
      categoryId: fund.id,
      amount: 50_000,
    })
    await api.setEmergencyFund({ categoryId: fund.id, months: 6, window: 3 })

    const lastComplete = await api.getEmergencyFund({ asOf: '2026-10', month: '2026-09' })
    expect(lastComplete.balance).toBe(50_000)
    expect(lastComplete.averageNeed).toBe(100_000)
    // the balance through September doesn't include October's allocation
    expect((await api.getEmergencyFund({ asOf: '2026-09' })).balance).toBe(0)
  })

  it('carries last month’s balance forward and draws it down when spent', async () => {
    const { api, fund, spend } = await makeApi()
    await api.setEmergencyFund({ categoryId: fund.id, months: 6, window: 3 })
    await api.allocate({ month: '2026-08', categoryId: fund.id, amount: 400_000 })
    await spend('2026-09-10', fund.id, 150_000)
    expect((await api.getEmergencyFund({ asOf: '2026-10' })).balance).toBe(250_000)
  })

  it('counts goals inside the category as part of the fund', async () => {
    const { api, fund } = await makeApi()
    await api.setEmergencyFund({ categoryId: fund.id, months: 6, window: 3 })
    const goal = await api.createGoal({
      categoryId: fund.id,
      name: 'Car repairs',
      targetAmount: 100_000,
    })
    await api.allocate({ month: '2026-10', categoryId: fund.id, amount: 100_000 })
    await api.allocate({ month: '2026-10', categoryId: fund.id, goalId: goal.id, amount: 50_000 })
    expect((await api.getEmergencyFund({ asOf: '2026-10' })).balance).toBe(150_000)
  })

  it('uses the chosen averaging window', async () => {
    const { api, rent, fund, spend } = await makeApi()
    await spend('2026-04-05', rent.id, 600_000)
    await spend('2026-10-05', rent.id, 300_000)
    await api.setEmergencyFund({ categoryId: fund.id, months: 6, window: 3 })
    expect((await api.getEmergencyFund({ asOf: '2026-10' })).averageNeed).toBe(100_000)
    await api.setEmergencyFund({ categoryId: fund.id, months: 6, window: 12 })
    expect((await api.getEmergencyFund({ asOf: '2026-10' })).averageNeed).toBe(
      Math.round(900_000 / 7),
    )
  })
})

describe('setEmergencyFund', () => {
  it('saves the settings', async () => {
    const { api, fund } = await makeApi()
    await api.setEmergencyFund({ categoryId: fund.id, months: 4, window: 6 })
    expect((await api.getEmergencyFund({ asOf: '2026-10' })).settings).toEqual({
      categoryId: fund.id,
      months: 4,
      window: 6,
    })
  })

  it('rejects coverage and windows out of range or fractional', async () => {
    const { api, fund } = await makeApi()
    for (const bad of [0, 25, 1.5]) {
      await expect(
        api.setEmergencyFund({ categoryId: fund.id, months: bad, window: 6 }),
      ).rejects.toThrow('Months of coverage')
    }
    for (const bad of [2, 13, 4.5]) {
      await expect(
        api.setEmergencyFund({ categoryId: fund.id, months: 6, window: bad }),
      ).rejects.toThrow('averaging window')
    }
  })

  it('rejects a missing category and a credit card payment category', async () => {
    const { api } = await makeApi()
    await expect(
      api.setEmergencyFund({ categoryId: 'nope', months: 6, window: 6 }),
    ).rejects.toThrow('Category not found')
    await api.createAccount({ name: 'Visa', type: 'credit' })
    const card = (await api.listCategoryGroups())
      .flatMap((g) => g.categories)
      .find((c) => c.creditCardAccountId)!
    await expect(
      api.setEmergencyFund({ categoryId: card.id, months: 6, window: 6 }),
    ).rejects.toThrow('credit card payment category')
  })

  it('can clear the category, and deleting the category clears it too', async () => {
    const { api, group } = await makeApi()
    const spare = await api.createCategory({ groupId: group.id, name: 'Spare' })
    await api.setEmergencyFund({ categoryId: spare.id, months: 6, window: 6 })
    await api.deleteCategory(spare.id)
    expect((await api.getEmergencyFund({ asOf: '2026-10' })).settings.categoryId).toBeNull()
    await expect(api.setEmergencyFund({ categoryId: null, months: 3, window: 3 })).resolves.toEqual(
      { categoryId: null, months: 3, window: 3 },
    )
  })

  it('travels as ordinary changes to the household row', async () => {
    const { api, adapter, fund } = await makeApi()
    await api.setEmergencyFund({ categoryId: fund.id, months: 4, window: 6 })
    const rows = await adapter.query<{ column_name: string; value: string | number }>(
      `SELECT column_name, value FROM messages
       WHERE table_name = 'households' AND column_name LIKE 'emergency_fund%'`,
    )
    expect(Object.fromEntries(rows.map((r) => [r.column_name, r.value]))).toEqual({
      emergency_fund_category_id: fund.id,
      emergency_fund_months: 4,
      emergency_fund_window: 6,
    })
  })
})

describe('migration 14', () => {
  it('moves a budget that already has the goal-based settings to the category column', async () => {
    const adapter = await openMemoryAdapter({ migrated: false })
    await migrate(adapter, { migrations: MIGRATIONS.filter((m) => m.version <= 13) })
    await adapter.exec(
      `INSERT INTO households (id, name, created_at, emergency_fund_months) VALUES ('h', 'Smiths', 't', 4)`,
    )
    await migrate(adapter)
    const [h] = await adapter.query('SELECT * FROM households')
    expect(h).toMatchObject({
      emergency_fund_category_id: null,
      emergency_fund_months: 4,
      emergency_fund_window: 12,
    })
    expect(h).not.toHaveProperty('emergency_fund_goal_id')
  })
})
