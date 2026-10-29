import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { needsWantsReport } from './reports.ts'
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
  const group = await api.createCategoryGroup({ name: 'Spending' })
  const rent = await api.createCategory({ groupId: group.id, name: 'Rent', needOrWant: 'need' })
  const fun = await api.createCategory({ groupId: group.id, name: 'Fun', needOrWant: 'want' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  return { api, rent, fun, checking }
}

describe('needsWantsReport (pure)', () => {
  const spent = new Map([
    ['2026-08', { need: 100_00, want: 40_00 }],
    ['2026-09', { need: 200_00, want: 10_00 }],
    ['2026-10', { need: 300_00, want: 0 }],
  ])

  it('lists every month in the window, with zeros for quiet ones', () => {
    const r = needsWantsReport(spent, '2026-10', 4, '2026-08')
    expect(r.months.map((m) => [m.month, m.need, m.want])).toEqual([
      ['2026-07', 0, 0],
      ['2026-08', 100_00, 40_00],
      ['2026-09', 200_00, 10_00],
      ['2026-10', 300_00, 0],
    ])
  })

  it('averages over the window, or over the months since spending began if fewer', () => {
    const r = needsWantsReport(spent, '2026-10', 12, '2026-08')
    expect(r.averages).toEqual([
      { window: 3, months: 3, need: 200_00, want: Math.round(50_00 / 3) },
      { window: 6, months: 3, need: 200_00, want: Math.round(50_00 / 3) },
      { window: 12, months: 3, need: 200_00, want: Math.round(50_00 / 3) },
    ])
  })

  it('counts quiet months inside the window against the average', () => {
    const r = needsWantsReport(
      new Map([['2026-04', { need: 600_00, want: 0 }]]),
      '2026-10',
      12,
      '2026-04',
    )
    expect(r.averages[1]).toEqual({ window: 6, months: 6, need: 0, want: 0 })
    expect(r.averages[2]).toEqual({ window: 12, months: 7, need: Math.round(600_00 / 7), want: 0 })
  })

  it('has nothing to average without spending', () => {
    const r = needsWantsReport(new Map(), '2026-10', 3, null)
    expect(r.averages.every((a) => a.months === 0 && a.need === 0 && a.want === 0)).toBe(true)
  })

  it('crosses year boundaries', () => {
    const r = needsWantsReport(
      new Map([['2025-12', { need: 5, want: 0 }]]),
      '2026-02',
      3,
      '2025-12',
    )
    expect(r.months.map((m) => m.month)).toEqual(['2025-12', '2026-01', '2026-02'])
  })
})

describe('getNeedsWantsReport', () => {
  it('splits spending by category tag and lets a split override it', async () => {
    const { api, rent, fun, checking } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-10-01', amount: 500_000 })
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-02',
      categoryId: rent.id,
      amount: -100_000,
    })
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-03',
      categoryId: fun.id,
      amount: -2_000,
    })
    // groceries are a need, the wine on the same receipt is a want
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-04',
      splits: [
        { categoryId: rent.id, amount: -8_000 },
        { categoryId: rent.id, needOrWant: 'want', amount: -1_500 },
        { categoryId: fun.id, needOrWant: 'need', amount: -500 },
      ],
    })
    const r = await api.getNeedsWantsReport({ month: '2026-10', months: 2 })
    expect(r.months).toEqual([
      { month: '2026-09', need: 0, want: 0 },
      { month: '2026-10', need: 108_500, want: 3_500 },
    ])
  })

  it('counts refunds against spending and ignores income, transfers between budget accounts and tracking accounts', async () => {
    const { api, rent, checking } = await makeApi()
    const savings = await api.createAccount({ name: 'Savings', type: 'savings' })
    const brokerage = await api.createAccount({ name: 'Brokerage', type: 'investment' })
    await api.createTransaction({ accountId: checking.id, date: '2026-10-01', amount: 500_000 })
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-02',
      categoryId: rent.id,
      amount: -10_000,
    })
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-03',
      categoryId: rent.id,
      amount: 2_500,
    })
    await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-10-04',
      amount: 50_000,
    })
    // spending inside a tracking account is not budget spending
    await api.createTransaction({
      accountId: brokerage.id,
      date: '2026-10-05',
      categoryId: rent.id,
      amount: -9_999,
    })
    const r = await api.getNeedsWantsReport({ month: '2026-10', months: 1 })
    expect(r.months).toEqual([{ month: '2026-10', need: 7_500, want: 0 }])
  })

  it('includes money sent to a tracking account under a category', async () => {
    const { api, fun, checking } = await makeApi()
    const brokerage = await api.createAccount({ name: 'Brokerage', type: 'investment' })
    await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: brokerage.id,
      date: '2026-10-04',
      amount: 20_000,
      categoryId: fun.id,
    })
    const r = await api.getNeedsWantsReport({ month: '2026-10', months: 1 })
    expect(r.months[0]).toMatchObject({ need: 0, want: 20_000 })
  })

  it('averages trailing months and rejects a bad window', async () => {
    const { api, rent, checking } = await makeApi()
    for (const [date, amount] of [
      ['2026-08-10', -30_000],
      ['2026-09-10', -60_000],
      ['2026-10-10', -90_000],
    ] as const) {
      await api.createTransaction({ accountId: checking.id, date, categoryId: rent.id, amount })
    }
    const r = await api.getNeedsWantsReport({ month: '2026-10' })
    expect(r.months).toHaveLength(12)
    expect(r.averages[0]).toEqual({ window: 3, months: 3, need: 60_000, want: 0 })
    // looking back from September leaves out October
    const sep = await api.getNeedsWantsReport({ month: '2026-09' })
    expect(sep.averages[0]).toEqual({ window: 3, months: 2, need: 45_000, want: 0 })
    await expect(api.getNeedsWantsReport({ month: '2026-10', months: 0 })).rejects.toThrow(
      /between/,
    )
    await expect(api.getNeedsWantsReport({ month: 'soon' })).rejects.toThrow(/not a month/)
  })
})
