import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { refillMonths } from './emergency-draws.ts'
import { openMemoryAdapter } from './test-utils.ts'

async function setup() {
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
  const car = await api.createCategory({
    groupId: group.id,
    name: 'Car repair',
    needOrWant: 'need',
  })
  const vet = await api.createCategory({ groupId: group.id, name: 'Vet', needOrWant: 'need' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  await api.createTransaction({ accountId: checking.id, date: '2026-01-01', amount: 5_000_000 })
  await api.createEmergencyFund()
  await api.allocate({ month: '2026-10', categoryId: 'emergency-fund', amount: 2_000_000 })
  const available = async (month: string, id: string) =>
    (await api.getMonthBalances(month)).find((b) => b.categoryId === id)?.available ?? 0
  const assigned = async (month: string, id: string) =>
    (await api.getMonthBalances(month)).find((b) => b.categoryId === id)?.assigned ?? 0
  const draws = async () =>
    adapter.query<{ month: string; category_id: string; amount: number; note: string }>(
      `SELECT month, category_id, SUM(amount) AS amount, MIN(note) AS note FROM allocations
       WHERE source_transaction_id IS NOT NULL AND fund_category_id IS NOT NULL
       GROUP BY month, category_id ORDER BY month, category_id`,
    )
  const emergency = (amount: number, over: Record<string, unknown> = {}) =>
    api.createTransaction({
      accountId: checking.id,
      date: '2026-10-05',
      payee: 'Garage',
      categoryId: car.id,
      amount: -amount,
      emergency: true,
      ...over,
    })
  return { api, adapter, group, car, vet, checking, available, assigned, draws, emergency }
}

describe('an emergency transaction', () => {
  it('moves its amount from the fund into its own category, which keeps the real spending', async () => {
    const { api, car, available, assigned, emergency } = await setup()
    const rta = await api.getReadyToAssign('2026-10')
    const t = await emergency(180_000)
    expect(t.emergency).toBe(true)
    expect(await available('2026-10', 'emergency-fund')).toBe(1_820_000)
    expect(await assigned('2026-10', car.id)).toBe(180_000)
    // the repair is spent from Car repair, whose own balance is untouched
    expect(await available('2026-10', car.id)).toBe(0)
    expect(
      (await api.getMonthBalances('2026-10')).find((b) => b.categoryId === car.id)?.activity,
    ).toBe(-180_000)
    expect(await api.getReadyToAssign('2026-10')).toBe(rta)
  })

  it('can be marked later, and unmarking gives the money back', async () => {
    const { api, car, available, emergency } = await setup()
    const t = await emergency(180_000, { emergency: false })
    expect(await available('2026-10', 'emergency-fund')).toBe(2_000_000)
    await api.updateTransaction(t.id, { emergency: true })
    expect(await available('2026-10', 'emergency-fund')).toBe(1_820_000)
    await api.updateTransaction(t.id, { emergency: false })
    expect(await available('2026-10', 'emergency-fund')).toBe(2_000_000)
    expect(await available('2026-10', car.id)).toBe(-180_000)
  })

  it('follows edits to the amount, category and month', async () => {
    const { api, car, vet, available, draws, emergency } = await setup()
    const t = await emergency(180_000)
    await api.updateTransaction(t.id, { amount: -250_000 })
    expect(await available('2026-10', 'emergency-fund')).toBe(1_750_000)
    await api.updateTransaction(t.id, { categoryId: vet.id })
    expect(await available('2026-10', car.id)).toBe(0)
    expect(await available('2026-10', vet.id)).toBe(0)
    expect(Object.fromEntries((await draws()).map((d) => [d.category_id, d.amount]))).toEqual({
      'emergency-fund': -250_000,
      [car.id]: 0,
      [vet.id]: 250_000,
    })
    await api.updateTransaction(t.id, { date: '2026-11-02' })
    expect(await available('2026-10', 'emergency-fund')).toBe(2_000_000)
    expect(await available('2026-11', 'emergency-fund')).toBe(1_750_000)
  })

  it('gives the money back when the transaction is deleted', async () => {
    const { api, available, emergency } = await setup()
    const t = await emergency(180_000)
    await api.deleteTransaction(t.id)
    expect(await available('2026-10', 'emergency-fund')).toBe(2_000_000)
  })

  it('writes nothing more when saved again unchanged', async () => {
    const { api, adapter, emergency } = await setup()
    const t = await emergency(180_000)
    const count = async () =>
      (await adapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM allocations'))[0]!.n
    const before = await count()
    await api.updateTransaction(t.id, { payee: 'Garage again', emergency: true })
    await api.updateTransaction(t.id, { cleared: true })
    expect(await count()).toBe(before)
  })

  it('moves each categorized line of a split, leaving out the fund and goal lines', async () => {
    const { api, car, vet, checking, available, group } = await setup()
    const goal = await api.createGoal({ categoryId: vet.id, name: 'Shots', targetAmount: 50_000 })
    await api.allocate({ month: '2026-10', categoryId: vet.id, goalId: goal.id, amount: 50_000 })
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-06',
      emergency: true,
      splits: [
        { categoryId: car.id, amount: -100_000 },
        { categoryId: car.id, amount: -20_000 },
        { categoryId: vet.id, goalId: goal.id, amount: -30_000 },
        { categoryId: 'emergency-fund', amount: -40_000 },
        { categoryId: null, amount: -5_000 },
      ],
    })
    expect(group.id).toBeTruthy()
    // 120k into Car repair; the goal line, the line already in the fund and the uncategorized one stay out
    expect(await available('2026-10', car.id)).toBe(0)
    expect(await available('2026-10', 'emergency-fund')).toBe(2_000_000 - 120_000 - 40_000)
  })

  it('moves a refund back to the fund', async () => {
    const { api, checking, car, available, emergency } = await setup()
    await emergency(180_000)
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-20',
      categoryId: car.id,
      amount: 30_000,
      emergency: true,
    })
    expect(await available('2026-10', 'emergency-fund')).toBe(1_850_000)
  })

  it('lets the fund go negative, which shows as overspent', async () => {
    const { available, emergency } = await setup()
    await emergency(2_500_000)
    expect(await available('2026-10', 'emergency-fund')).toBe(-500_000)
  })
})

describe('marking an emergency is refused when it can’t be paid from the fund', () => {
  it('needs a fund, a budget account and not a transfer', async () => {
    const { api, checking, car, emergency } = await setup()
    const savings = await api.createAccount({ name: 'Savings', type: 'savings' })
    const tracking = await api.createAccount({
      name: 'House',
      type: 'investment',
      onBudget: false,
    })
    await expect(
      api.createTransaction({
        accountId: tracking.id,
        date: '2026-10-05',
        categoryId: car.id,
        amount: -100,
        emergency: true,
      }),
    ).rejects.toThrow('budget account')
    const [out] = await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-10-05',
      amount: 1_000,
    })
    await expect(api.updateTransaction(out.id, { emergency: true })).rejects.toThrow('transfer')
    const t = await emergency(100)
    await api.deleteEmergencyFund({ month: '2026-10' })
    await expect(emergency(100)).rejects.toThrow('Start an emergency fund first')
    // unmarking always works, with or without a fund
    await expect(api.updateTransaction(t.id, { emergency: false })).resolves.toMatchObject({
      emergency: false,
    })
  })
})

describe('an emergency waiting in the inbox', () => {
  it('is paid for from the fund once approved', async () => {
    const { api, adapter, available, emergency } = await setup()
    const t = await emergency(180_000, { emergency: false })
    await adapter.exec('UPDATE transactions SET approved = 0 WHERE id = ?', [t.id])
    await api.updateTransaction(t.id, { emergency: true })
    expect(await available('2026-10', 'emergency-fund')).toBe(2_000_000)
    await api.approveTransactions([t.id])
    expect(await available('2026-10', 'emergency-fund')).toBe(1_820_000)
  })
})

describe('after the fund is deleted', () => {
  it('leaves earlier draws as history, and a new fund starts clean', async () => {
    const { api, car, available, assigned, emergency } = await setup()
    const t = await emergency(180_000)
    await api.deleteEmergencyFund({ month: '2026-10' })
    // the fund's balance (2,000,000 - 180,000) went back to Ready to Assign; Car repair keeps its 180,000
    expect(await assigned('2026-10', car.id)).toBe(180_000)
    await api.updateTransaction(t.id, { emergency: false })
    expect(await assigned('2026-10', car.id)).toBe(180_000)
    expect(await available('2026-10', 'emergency-fund')).toBe(0)
  })
})

describe('refillMonths (pure)', () => {
  const balances = (pairs: [string, number][]) => new Map(pairs)
  it('counts the months until the fund is back at its level', () => {
    const b = balances([
      ['2026-03', 500],
      ['2026-04', 600],
      ['2026-05', 900],
      ['2026-06', 1_000],
    ])
    expect(refillMonths(b, '2026-03', 1_000)).toBe(3)
  })
  it('is 0 when it never fell below, null when it has not recovered or has no level', () => {
    const b = balances([
      ['2026-03', 1_000],
      ['2026-04', 400],
    ])
    expect(refillMonths(b, '2026-03', 1_000)).toBe(0)
    expect(refillMonths(b, '2026-04', 1_000)).toBeNull()
    expect(refillMonths(b, '2026-03', 0)).toBeNull()
  })
})

describe('getEmergencyReport', () => {
  it('lists the year’s emergencies with what each took and how long the fund took to refill', async () => {
    const { api, car, vet, emergency } = await setup()
    // the fund holds 2,000,000 in October (setup); two emergencies that month
    await emergency(300_000)
    await emergency(100_000, { categoryId: vet.id, payee: 'Vet', date: '2026-10-12' })
    // November adds nothing, December tops it back up
    await api.allocate({ month: '2026-12', categoryId: 'emergency-fund', amount: 400_000 })
    const report = await api.getEmergencyReport({ year: 2026, asOf: '2026-12' })
    expect(report.hasFund).toBe(true)
    expect(report.total).toBe(400_000)
    expect(report.draws.map((d) => [d.payee, d.drawn, d.categoryIds])).toEqual([
      ['Vet', 100_000, [vet.id]],
      ['Garage', 300_000, [car.id]],
    ])
    // both left October with 1,600,000, which is 2,000,000 less the 400,000 they took
    expect(report.draws.map((d) => d.balanceAfter)).toEqual([1_600_000, 1_600_000])
    expect(report.draws.map((d) => d.refilledIn)).toEqual([2, 2])
  })

  it('leaves out other years, transfers and emergencies that were unmarked', async () => {
    const { api, emergency } = await setup()
    const kept = await emergency(50_000)
    const dropped = await emergency(70_000, { date: '2026-10-09' })
    await api.updateTransaction(dropped.id, { emergency: false })
    await emergency(90_000, { date: '2025-12-30' })
    const report = await api.getEmergencyReport({ year: 2026, asOf: '2026-10' })
    expect(report.draws.map((d) => d.transactionId)).toEqual([kept.id])
    expect(report.draws[0]?.refilledIn).toBeNull()
  })

  it('keeps listing draws as history once the fund is deleted', async () => {
    const { api, emergency } = await setup()
    await emergency(50_000)
    await api.deleteEmergencyFund({ month: '2026-10' })
    const report = await api.getEmergencyReport({ year: 2026, asOf: '2026-10' })
    expect(report.hasFund).toBe(false)
    expect(report.total).toBe(50_000)
    expect(report.draws[0]).toMatchObject({ balanceAfter: null, refilledIn: null })
  })

  it('is empty for a year with none', async () => {
    const { api } = await setup()
    expect(await api.getEmergencyReport({ year: 2026, asOf: '2026-10' })).toEqual({
      year: 2026,
      hasFund: true,
      draws: [],
      total: 0,
    })
  })
})
