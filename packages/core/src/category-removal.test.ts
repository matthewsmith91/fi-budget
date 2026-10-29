import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { openMemoryAdapter } from './test-utils.ts'

const OCT = '2026-10'

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
  const group = await api.createCategoryGroup({ name: 'Home' })
  const food = await api.createCategory({ groupId: group.id, name: 'Food' })
  const spare = await api.createCategory({ groupId: group.id, name: 'Spare' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  await api.createTransaction({ accountId: checking.id, date: '2026-10-01', amount: 100_000 })
  const available = async (id: string) =>
    (await api.getMonthBalances(OCT)).find((b) => b.categoryId === id)!.available
  return { api, group, food, spare, checking, available }
}

describe('removing a category', () => {
  it('deletes one that was never used', async () => {
    const { api, spare } = await makeApi()
    const plan = await api.planCategoryRemoval(spare.id, { month: OCT })
    expect(plan).toMatchObject({ outcome: 'deleted', returned: 0, blocked: null })
    expect(await api.removeCategory(spare.id, { month: OCT })).toEqual(plan)
    const names = (await api.listCategoryGroups()).flatMap((g) => g.categories.map((c) => c.name))
    expect(names).toEqual(['Food'])
  })

  it('hides one with history, keeps it on its transactions and returns its money', async () => {
    const { api, food, checking, available } = await makeApi()
    await api.allocate({ month: OCT, categoryId: food.id, amount: 30_000 })
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-05',
      amount: -12_000,
      categoryId: food.id,
    })
    expect(await api.getReadyToAssign(OCT)).toBe(70_000)
    expect(await available(food.id)).toBe(18_000)

    const plan = await api.planCategoryRemoval(food.id, { month: OCT })
    expect(plan).toMatchObject({ outcome: 'hidden', returned: 18_000, blocked: null })
    await api.removeCategory(food.id, { month: OCT })

    // the money is back in Ready to Assign; the category and its spending stay
    expect(await api.getReadyToAssign(OCT)).toBe(88_000)
    expect(await available(food.id)).toBe(0)
    const kept = (await api.listCategoryGroups())
      .flatMap((g) => g.categories)
      .find((c) => c.id === food.id)
    expect(kept?.hidden).toBe(true)
    const spent = (await api.listTransactions({ accountId: checking.id })).find(
      (t) => t.amount === -12_000,
    )
    expect(spent?.splits[0]?.categoryId).toBe(food.id)
  })

  it('archives its goals and returns what they hold', async () => {
    const { api, food, available } = await makeApi()
    const trip = await api.createGoal({ categoryId: food.id, name: 'Trip', targetAmount: 50_000 })
    await api.allocate({ month: OCT, categoryId: food.id, amount: 10_000 })
    await api.allocate({ month: OCT, categoryId: food.id, goalId: trip.id, amount: 20_000 })
    const plan = await api.planCategoryRemoval(food.id, { month: OCT })
    expect(plan).toMatchObject({ outcome: 'hidden', returned: 30_000, goals: 1 })
    await api.removeCategory(food.id, { month: OCT })
    expect(await api.getReadyToAssign(OCT)).toBe(100_000)
    expect(await available(food.id)).toBe(0)
    expect((await api.listGoals()).find((g) => g.id === trip.id)?.archived).toBe(true)
  })

  it('refuses an overspent category, saying why', async () => {
    const { api, food, checking } = await makeApi()
    await api.allocate({ month: OCT, categoryId: food.id, amount: 5_000 })
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-05',
      amount: -9_000,
      categoryId: food.id,
    })
    const plan = await api.planCategoryRemoval(food.id, { month: OCT })
    expect(plan.blocked).toMatch(/overspent by \$40\.00/)
    await expect(api.removeCategory(food.id, { month: OCT })).rejects.toThrow(/overspent/)
    const still = (await api.listCategoryGroups())
      .flatMap((g) => g.categories)
      .find((c) => c.id === food.id)
    expect(still?.hidden).toBe(false)
  })

  it('refuses a credit card payment category', async () => {
    const { api } = await makeApi()
    await api.createAccount({ name: 'Visa', type: 'credit' })
    const card = (await api.listCategoryGroups())
      .flatMap((g) => g.categories)
      .find((c) => c.creditCardAccountId)!
    await expect(api.removeCategory(card.id, { month: OCT })).rejects.toThrow(/goes with its card/)
  })

  it('drops its rules and stops it being the emergency fund', async () => {
    const { api, food } = await makeApi()
    await api.createHousehold({ name: 'Smiths', members: ['Matt', 'Jessica'] })
    await api.allocate({ month: OCT, categoryId: food.id, amount: 1_000 })
    await api.createPayeeRule({ match: 'Kroger', categoryId: food.id })
    await api.setEmergencyFund({ categoryId: food.id, months: 6, window: 6 })
    const plan = await api.planCategoryRemoval(food.id, { month: OCT })
    expect(plan).toMatchObject({ rules: 1, emergencyFund: true })
    await api.removeCategory(food.id, { month: OCT })
    expect(await api.listPayeeRules()).toEqual([])
    expect((await api.getEmergencyFund({ asOf: OCT })).settings.categoryId).toBeNull()
  })
})
