import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { addDays, daysBetween, recurringOccurrences, stepRecurring } from './recurring.ts'
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
  const group = await api.createCategoryGroup({ name: 'Bills' })
  const rentCategory = await api.createCategory({
    groupId: group.id,
    name: 'Rent',
    needOrWant: 'need',
  })
  const streaming = await api.createCategory({ groupId: group.id, name: 'Streaming' })
  await api.createTransaction({ accountId: checking.id, date: '2026-10-01', amount: 100_000 })
  return { api, checking, rentCategory, streaming }
}

describe('dates (pure)', () => {
  it('adds and counts days across month ends', () => {
    expect(addDays('2026-10-29', 3)).toBe('2026-11-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(daysBetween('2026-10-29', '2026-12-01')).toBe(33)
    expect(daysBetween('2026-12-01', '2026-10-29')).toBe(-33)
  })
})

describe('stepRecurring (pure)', () => {
  it('steps by days for weekly and biweekly', () => {
    expect(stepRecurring('2026-12-28', 'weekly', 28)).toBe('2027-01-04')
    expect(stepRecurring('2026-12-28', 'biweekly', 28)).toBe('2027-01-11')
  })

  it('keeps a monthly bill to its day, short months included', () => {
    let date = '2026-01-31'
    const seen = [date]
    for (let i = 0; i < 4; i++) seen.push((date = stepRecurring(date, 'monthly', 31)))
    expect(seen).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'])
    expect(stepRecurring('2028-01-31', 'monthly', 31)).toBe('2028-02-29')
  })

  it('steps a quarter or a year, and finds a leap day again', () => {
    expect(stepRecurring('2026-11-30', 'quarterly', 30)).toBe('2027-02-28')
    expect(stepRecurring('2026-10-15', 'yearly', 15)).toBe('2027-10-15')
    expect(stepRecurring('2027-02-28', 'yearly', 29)).toBe('2028-02-29')
  })
})

describe('recurringOccurrences (pure)', () => {
  const rent = { next_date: '2026-10-01', cadence: 'monthly', anchor_day: 1 } as const

  it('lists what falls in the window, window ends included', () => {
    expect(recurringOccurrences(rent, '2026-10-01', '2026-12-01')).toEqual([
      { date: '2026-10-01', overdue: false },
      { date: '2026-11-01', overdue: false },
      { date: '2026-12-01', overdue: false },
    ])
    expect(recurringOccurrences(rent, '2026-10-02', '2026-10-31')).toEqual([
      { date: '2026-10-01', overdue: true },
    ])
  })

  it('counts a missed item once, not once for every month missed', () => {
    expect(
      recurringOccurrences({ ...rent, next_date: '2026-06-01' }, '2026-10-29', '2026-11-30'),
    ).toEqual([
      { date: '2026-06-01', overdue: true },
      { date: '2026-11-01', overdue: false },
    ])
  })

  it('is empty before the next date', () => {
    expect(recurringOccurrences(rent, '2026-08-01', '2026-09-30')).toEqual([])
  })
})

describe('recurring items', () => {
  it('creates, lists in date order, updates and deletes', async () => {
    const { api, checking, rentCategory } = await makeApi()
    const rent = await api.createRecurring({
      payee: ' Landlord ',
      amount: -150_000,
      cadence: 'monthly',
      nextDate: '2026-11-01',
      categoryId: rentCategory.id,
      accountId: checking.id,
    })
    const phone = await api.createRecurring({
      payee: 'Phone',
      amount: -8_000,
      cadence: 'monthly',
      nextDate: '2026-10-15',
    })
    expect(rent).toMatchObject({
      payee: 'Landlord',
      categoryId: rentCategory.id,
      accountId: checking.id,
    })
    expect((await api.listRecurring()).map((i) => i.payee)).toEqual(['Phone', 'Landlord'])
    expect((await api.updateRecurring(phone.id, { amount: -9_000, categoryId: null })).amount).toBe(
      -9_000,
    )
    await api.deleteRecurring(phone.id)
    expect((await api.listRecurring()).map((i) => i.id)).toEqual([rent.id])
    await expect(api.deleteRecurring(phone.id)).rejects.toThrow(/not found/)
  })

  it('refuses what makes no sense', async () => {
    const { api, checking, rentCategory } = await makeApi()
    const ok = { payee: 'Rent', amount: -100, cadence: 'monthly', nextDate: '2026-11-01' } as const
    await expect(api.createRecurring({ ...ok, payee: ' ' })).rejects.toThrow(
      /Payee name is required/,
    )
    await expect(api.createRecurring({ ...ok, amount: 0 })).rejects.toThrow(/not zero/)
    await expect(api.createRecurring({ ...ok, amount: 1.5 })).rejects.toThrow(/whole number/)
    await expect(api.createRecurring({ ...ok, nextDate: '2026-02-30' })).rejects.toThrow(
      /not a date/,
    )
    await expect(
      api.createRecurring({ ...ok, cadence: 'daily' as unknown as 'monthly' }),
    ).rejects.toThrow(/Unknown cadence/)
    await expect(api.createRecurring({ ...ok, categoryId: 'nope' })).rejects.toThrow(
      /Category not found/,
    )
    await expect(api.createRecurring({ ...ok, accountId: 'nope' })).rejects.toThrow(
      /Account not found/,
    )
    await api.updateAccount(checking.id, { closed: true })
    await expect(api.createRecurring({ ...ok, accountId: checking.id })).rejects.toThrow(/closed/)
    void rentCategory
  })

  it('advances to the next occurrence and keeps to the day it was entered on', async () => {
    const { api } = await makeApi()
    const item = await api.createRecurring({
      payee: 'Insurance',
      amount: -20_000,
      cadence: 'monthly',
      nextDate: '2027-01-31',
    })
    const dates = []
    let current = item
    for (let i = 0; i < 3; i++) {
      current = await api.advanceRecurring(item.id)
      dates.push(current.nextDate)
    }
    expect(dates).toEqual(['2027-02-28', '2027-03-31', '2027-04-30'])
    // typing a new date picks a new day to keep to
    await api.updateRecurring(item.id, { nextDate: '2027-05-15' })
    expect((await api.advanceRecurring(item.id)).nextDate).toBe('2027-06-15')
  })

  it('lets go of an account or category that is deleted', async () => {
    const { api, rentCategory } = await makeApi()
    const spare = await api.createAccount({ name: 'Spare', type: 'checking' })
    const item = await api.createRecurring({
      payee: 'Rent',
      amount: -100,
      cadence: 'monthly',
      nextDate: '2026-11-01',
      categoryId: rentCategory.id,
      accountId: spare.id,
    })
    await api.deleteAccount(spare.id)
    expect(await api.listRecurring()).toEqual([
      expect.objectContaining({ id: item.id, accountId: null }),
    ])
    await api.deleteCategory(rentCategory.id)
    expect(await api.listRecurring()).toEqual([
      expect.objectContaining({ id: item.id, categoryId: null }),
    ])
  })
})

describe('getBillsCalendar', () => {
  it('puts each occurrence on its day with its need or want, and totals the month', async () => {
    const { api, rentCategory, streaming } = await makeApi()
    await api.createRecurring({
      payee: 'Landlord',
      amount: -150_000,
      cadence: 'monthly',
      nextDate: '2026-10-01',
      categoryId: rentCategory.id,
    })
    await api.createRecurring({
      payee: 'Netflix',
      amount: -1_500,
      cadence: 'monthly',
      nextDate: '2026-10-15',
      categoryId: streaming.id,
    })
    await api.createRecurring({
      payee: 'Paycheck',
      amount: 200_000,
      cadence: 'biweekly',
      nextDate: '2026-11-06',
    })
    const nov = await api.getBillsCalendar({ month: '2026-11' })
    expect(nov.days.map((d) => [d.date, d.items.map((i) => i.payee)])).toEqual([
      ['2026-11-01', ['Landlord']],
      ['2026-11-06', ['Paycheck']],
      ['2026-11-15', ['Netflix']],
      ['2026-11-20', ['Paycheck']],
    ])
    expect(nov.days[0]!.items[0]).toMatchObject({ amount: -150_000, needOrWant: 'need' })
    expect(nov.days[2]!.items[0]!.needOrWant).toBe('want')
    expect(nov.days[1]!.items[0]!.needOrWant).toBeNull()
    expect(nov).toMatchObject({ due: 151_500, expected: 400_000 })
    // an item has nothing before its next date
    expect((await api.getBillsCalendar({ month: '2026-09' })).days).toEqual([])
  })
})

describe('getCashFlowForecast', () => {
  async function scenario() {
    const c = await makeApi()
    const { api } = c
    await api.createRecurring({
      payee: 'Landlord',
      amount: -150_000,
      cadence: 'monthly',
      nextDate: '2026-11-01',
    })
    await api.createRecurring({
      payee: 'Paycheck',
      amount: 200_000,
      cadence: 'biweekly',
      nextDate: '2026-11-06',
    })
    await api.createRecurring({
      payee: 'Gas',
      amount: -5_000,
      cadence: 'monthly',
      nextDate: '2026-10-25',
    })
    return c
  }

  it('runs the balance forward, counting a missed bill once on the first day', async () => {
    const { api } = await scenario()
    const f = await api.getCashFlowForecast({ from: '2026-10-29', days: 30 })
    expect(f.days).toHaveLength(30)
    expect(f.days[0]!.date).toBe('2026-10-29')
    expect(f.days[29]!.date).toBe('2026-11-27')
    expect(f.startBalance).toBe(100_000)
    const at = (date: string) => f.days.find((d) => d.date === date)!
    expect(at('2026-10-29')).toMatchObject({
      balance: 95_000,
      events: [{ payee: 'Gas', amount: -5_000, overdue: true }],
    })
    expect(at('2026-11-01').balance).toBe(-55_000)
    expect(at('2026-11-06').balance).toBe(145_000)
    expect(at('2026-11-20').balance).toBe(345_000)
    expect(at('2026-11-25').balance).toBe(340_000)
    expect(f).toMatchObject({
      endBalance: 340_000,
      lowest: { date: '2026-11-01', balance: -55_000 },
      firstNegative: '2026-11-01',
      inflow: 400_000,
      outflow: 160_000,
    })
  })

  it('has no negative day when the money lasts', async () => {
    const { api } = await makeApi()
    await api.createRecurring({
      payee: 'Phone',
      amount: -8_000,
      cadence: 'weekly',
      nextDate: '2026-10-30',
    })
    const f = await api.getCashFlowForecast({ from: '2026-10-29', days: 14 })
    expect(f.firstNegative).toBeNull()
    // weekly on the 30th and 6th fall in two weeks; the 13th does not
    expect(f.lowest).toEqual({ date: '2026-11-06', balance: 100_000 - 8_000 * 2 })
  })

  it('counts only the budget’s checking and savings accounts as cash', async () => {
    const { api } = await scenario()
    const card = await api.createAccount({ name: 'Card', type: 'credit' })
    await api.createTransaction({ accountId: card.id, date: '2026-10-10', amount: -40_000 })
    const savings = await api.createAccount({ name: 'Savings', type: 'savings' })
    await api.createTransaction({ accountId: savings.id, date: '2026-10-10', amount: 50_000 })
    const tracking = await api.createAccount({
      name: 'Old 401k bank',
      type: 'checking',
      onBudget: false,
    })
    await api.createTransaction({ accountId: tracking.id, date: '2026-10-10', amount: 900_000 })
    const f = await api.getCashFlowForecast({ from: '2026-10-29', days: 7 })
    expect(f.startBalance).toBe(150_000)
    expect(f.accounts.map((a) => a.name).sort()).toEqual(['Checking', 'Savings'])
  })

  it('leaves out an item on a tracking account and counts a bill on a card as paid at once', async () => {
    const { api } = await makeApi()
    const tracking = await api.createAccount({
      name: 'Mortgage',
      type: 'checking',
      onBudget: false,
    })
    const card = await api.createAccount({ name: 'Card', type: 'credit' })
    await api.createRecurring({
      payee: 'Mortgage',
      amount: -90_000,
      cadence: 'monthly',
      nextDate: '2026-11-01',
      accountId: tracking.id,
    })
    await api.createRecurring({
      payee: 'Gym',
      amount: -3_000,
      cadence: 'monthly',
      nextDate: '2026-11-02',
      accountId: card.id,
    })
    const f = await api.getCashFlowForecast({ from: '2026-10-29', days: 7 })
    expect(f.outflow).toBe(3_000)
    expect(f.endBalance).toBe(97_000)
  })

  it('checks the window', async () => {
    const { api } = await makeApi()
    await expect(api.getCashFlowForecast({ from: '2026-10-29', days: 3 })).rejects.toThrow(
      /7 and 90/,
    )
    await expect(api.getCashFlowForecast({ from: '2026-10-29', days: 120 })).rejects.toThrow(
      /7 and 90/,
    )
    await expect(api.getCashFlowForecast({ from: 'soon' })).rejects.toThrow(/not a date/)
    expect((await api.getCashFlowForecast({ from: '2026-10-29' })).days).toHaveLength(60)
  })
})
