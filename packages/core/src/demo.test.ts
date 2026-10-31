import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createBudgetApi, type BudgetApi } from './api.ts'
import { seedDemoBudget } from './demo.ts'
import { openMemoryAdapter } from './test-utils.ts'

// Seeding a year of history takes a couple of seconds, more when the suite runs in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

async function seeded(today: string) {
  const adapter = await openMemoryAdapter()
  const api = createBudgetApi({ adapter, storage: 'memory', sqliteVersion: 'test' })
  await seedDemoBudget(api, { today })
  return api
}

// The date decides which paychecks and bills have happened, so try the awkward ones: the
// first day of a month (little income yet), a mid-month day and the last day.
describe.each(['2026-10-01', '2026-10-15', '2026-10-31', '2027-03-03'])(
  'demo budget as of %s',
  (today) => {
    const month = today.slice(0, 7)
    let api: BudgetApi
    beforeAll(async () => {
      api = await seeded(today)
    })

    it('never assigns more than there is', async () => {
      expect(await api.getReadyToAssign(month)).toBeGreaterThanOrEqual(0)
    })

    it('has the cases a demo needs', async () => {
      const [categories, balances, accounts, review, fund, inbox] = await Promise.all([
        api.listCategoryGroups(),
        api.getMonthBalances(month),
        api.listAccounts(),
        api.getMonthlyReview({ month }),
        api.getEmergencyFund({ asOf: month }),
        api.listInbox(),
      ])
      const name = (id: string) =>
        categories.flatMap((g) => g.categories).find((c) => c.id === id)?.name

      // accounts of every type, one closed, one off budget
      expect(new Set(accounts.map((a) => a.type))).toEqual(
        new Set(['checking', 'savings', 'credit', 'investment']),
      )
      expect(accounts.some((a) => a.closed)).toBe(true)
      expect(accounts.some((a) => !a.onBudget && a.type !== 'investment')).toBe(true)

      // overspent categories, an underfunded goal, a goal-account mismatch, a part-built fund
      const over = balances.filter((b) => b.available < 0).map((b) => name(b.categoryId))
      expect(over).toEqual(expect.arrayContaining(['Dining Out', 'Car Maintenance']))
      expect(review.underfunded.length).toBeGreaterThan(0)
      expect(review.overAllocated.length).toBeGreaterThan(0)
      expect(fund.balance).toBeGreaterThan(0)
      expect(fund.shortfall).toBeGreaterThan(0)

      // waiting in the inbox, with something to merge and something a rule categorized
      expect(inbox.length).toBeGreaterThanOrEqual(8)
      expect(inbox.some((i) => i.transaction.splits[0]?.categoryId)).toBe(true)
      expect(inbox.some((i) => i.possibleDuplicates.length > 0)).toBe(true)
    })

    it('has cleared and uncleared transactions and income rule allocations', async () => {
      const all = await api.listTransactions()
      expect(all.some((t) => t.cleared)).toBe(true)
      expect(all.some((t) => !t.cleared)).toBe(true)
      const report = await api.getIncomeRulesReport(month)
      expect(report.deposits.length).toBeGreaterThan(0)
    })
  },
)

describe('demo budget details', () => {
  const today = '2026-10-31'
  const month = today.slice(0, 7)
  let api: BudgetApi
  beforeAll(async () => {
    api = await seeded(today)
  })

  it('has planning data for every report', async () => {
    const [net, retirement, spending, plans, roth, bills, forecast] = await Promise.all([
      api.getNetWorthReport({ month, months: 12 }),
      api.getRetirementProjection({ asOf: month }),
      api.getRetirementSpending({ month, asOf: month }),
      api.getEducationProjections({ asOf: month }),
      api.getRothContributions(2026),
      api.getBillsCalendar({ month }),
      api.getCashFlowForecast({ from: today }),
    ])
    expect(net.months.at(-1)!.netWorth).toBeGreaterThan(0)
    expect(retirement.projected).toBeGreaterThan(0)
    expect(spending.annualSpend).toBeGreaterThan(0)
    expect(plans).toHaveLength(2)
    expect(roth.members.some((p) => p.contributed > 0)).toBe(true)
    expect(bills.due).toBeGreaterThan(0)
    expect(forecast.days.length).toBeGreaterThan(0)
  })

  it('splits the brokerage and the 529 by goal', async () => {
    const accounts = await api.listAccounts()
    const brokerage = accounts.find((a) => a.name === 'Brokerage')!
    const college = accounts.find((a) => a.name === 'Emma 529')!
    const b = await api.getAccountInvestments(brokerage.id)
    expect(b.goals.length).toBeGreaterThan(1) // the house goal and Unassigned
    const c = await api.getAccountInvestments(college.id)
    expect(c.goals.some((g) => g.value > 0)).toBe(true)
  })
})
