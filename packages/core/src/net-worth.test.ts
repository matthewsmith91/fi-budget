import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { netWorthReport, valueAtMonthEnd, type AccountHistory } from './net-worth.ts'
import { openMemoryAdapter } from './test-utils.ts'

const history = (over: Partial<AccountHistory>): AccountHistory => ({
  accountId: 'a',
  name: 'A',
  type: 'checking',
  closed: false,
  flows: new Map(),
  valuations: [],
  ...over,
})

describe('valueAtMonthEnd (pure)', () => {
  it('adds up an ordinary account’s transactions through the month', () => {
    const a = history({
      flows: new Map([
        ['2026-08', 100],
        ['2026-09', -30],
        ['2026-10', 5],
      ]),
    })
    expect(valueAtMonthEnd(a, '2026-07')).toBe(0)
    expect(valueAtMonthEnd(a, '2026-09')).toBe(70)
    expect(valueAtMonthEnd(a, '2026-12')).toBe(75)
  })

  it('values an investment account by its newest valuation on or before the month’s end', () => {
    const a = history({
      type: 'investment',
      flows: new Map([['2026-07', 500]]),
      valuations: [
        ['2026-08-15', 900],
        ['2026-09-30', 1_000],
        ['2026-09-02', 950],
      ],
    })
    expect(valueAtMonthEnd(a, '2026-07')).toBe(500) // before any valuation: what went in
    expect(valueAtMonthEnd(a, '2026-08')).toBe(900)
    expect(valueAtMonthEnd(a, '2026-09')).toBe(1_000)
    expect(valueAtMonthEnd(a, '2026-11')).toBe(1_000)
  })
})

describe('netWorthReport (pure)', () => {
  it('separates assets from liabilities and lists month by month', () => {
    const r = netWorthReport(
      [
        history({ accountId: 'c', name: 'Checking', flows: new Map([['2026-09', 1_000]]) }),
        history({
          accountId: 'v',
          name: 'Visa',
          type: 'credit',
          flows: new Map([['2026-10', -300]]),
        }),
      ],
      '2026-10',
      3,
    )
    expect(r.months).toEqual([
      { month: '2026-08', netWorth: 0, assets: 0, liabilities: 0 },
      { month: '2026-09', netWorth: 1_000, assets: 1_000, liabilities: 0 },
      { month: '2026-10', netWorth: 700, assets: 1_000, liabilities: -300 },
    ])
    expect(r.accounts.map((a) => [a.name, a.value])).toEqual([
      ['Checking', 1_000],
      ['Visa', -300],
    ])
  })
})

describe('getNetWorthReport', () => {
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
    const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
    const brokerage = await api.createAccount({ name: 'Brokerage', type: 'investment' })
    return { api, checking, brokerage }
  }

  it('tracks cash, a moved-in contribution and a later valuation across months', async () => {
    const { api, checking, brokerage } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-08-05', amount: 1_000_00 })
    await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: brokerage.id,
      date: '2026-09-10',
      amount: 400_00,
    })
    await api.recordValuation({ accountId: brokerage.id, date: '2026-10-15', marketValue: 450_00 })

    const r = await api.getNetWorthReport({ month: '2026-10', months: 4 })
    expect(r.months.map((m) => [m.month, m.netWorth])).toEqual([
      ['2026-07', 0],
      ['2026-08', 1_000_00],
      ['2026-09', 1_000_00], // the $400 moved is still worth $400 in the brokerage
      ['2026-10', 1_050_00], // and is now worth $450
    ])
    expect(r.accounts.map((a) => [a.name, a.value])).toEqual([
      ['Checking', 600_00],
      ['Brokerage', 450_00],
    ])
  })

  it('keeps a closed account’s history and rejects a bad window', async () => {
    const { api, checking } = await makeApi()
    await api.createTransaction({ accountId: checking.id, date: '2026-10-01', amount: 100_00 })
    await api.updateAccount(checking.id, { closed: true })
    expect((await api.getNetWorthReport({ month: '2026-10', months: 1 })).months[0]!.netWorth).toBe(
      100_00,
    )
    await expect(api.getNetWorthReport({ month: '2026-10', months: 0 })).rejects.toThrow(
      /1 and 120/,
    )
    await expect(api.getNetWorthReport({ month: '2026-13' })).rejects.toThrow()
  })
})
