import { assertMonth, type Month } from './allocations.ts'
import type { CrudDeps } from './crud.ts'
import type { InvestmentKind } from './investments.ts'
import { loadAccountHistories, valueAtMonthEnd } from './net-worth.ts'
import { readProfiles, RETIREMENT_AGE_RANGE, type ProfileSettings } from './profiles.ts'
import type { SqlRunner } from './storage.ts'

/** The age to follow when nobody is in the plan yet; each person's own is on their profile. */
export const TARGET_AGE_RANGE = RETIREMENT_AGE_RANGE
export const RETURN_RATE_RANGE = { min: -10, max: 30, default: 7 } as const
export const INFLATION_RATE_RANGE = { min: -5, max: 20, default: 3 } as const
export const WITHDRAWAL_RATE_RANGE = { min: 1, max: 10, default: 4 } as const
export const LOOKBACK_RANGE = { min: 3, max: 36, default: 12 } as const

/** Investment accounts that count toward retirement; a brokerage, a 529 and `other` do not. */
export const RETIREMENT_KINDS: readonly InvestmentKind[] = [
  'ira',
  '401k',
  '403b',
  '457',
  '401a',
  'sep-ira',
  'simple-ira',
]

/**
 * The household's market assumptions. What belongs to a person (birth month, retirement age,
 * contribution, income, benefits) is on their profile.
 */
export interface RetirementSettings {
  /** Expected yearly return before inflation, in percent. */
  returnRate: number
  /** Expected yearly inflation, in percent. */
  inflationRate: number
  /** The share of the portfolio spent each year in retirement, in percent (the 4% rule). */
  withdrawalRate: number
  /** How many trailing months of real spending the retirement baseline averages. */
  lookbackMonths: number
}

export const DEFAULT_RETIREMENT_SETTINGS: RetirementSettings = {
  returnRate: RETURN_RATE_RANGE.default,
  inflationRate: INFLATION_RATE_RANGE.default,
  withdrawalRate: WITHDRAWAL_RATE_RANGE.default,
  lookbackMonths: LOOKBACK_RANGE.default,
}

export interface RetirementPoint {
  /** The calendar month this point is for. */
  month: Month
  /** Age in years, to two decimals. */
  age: number
  /** Portfolio value in today's dollars, integer cents. */
  balance: number
  /** Everything contributed up to this point, integer cents. */
  contributed: number
}

export interface RetirementAccountValue {
  accountId: string
  name: string
  /** Its value at the end of `asOf`. */
  value: number
}

/** One person the plan counts, as of the month projected from. */
export interface RetirementPerson extends Omit<ProfileSettings, 'birthMonth'> {
  memberId: string
  name: string
  birthMonth: Month
  /** The month they stop working. */
  retirementMonth: Month
  /** Their age in months at `asOf`. */
  ageMonths: number
  /** Months from `asOf` until they retire; 0 once they have. */
  monthsToRetire: number
  /** The yearly percent their contribution grows by after inflation; 0 when it stays flat. */
  contributionGrowth: number
}

/** A profile the plan leaves out, and what to change to bring it in. */
export interface RetirementSkipped {
  memberId: string
  name: string
  note: string
}

export interface RetirementProjection {
  settings: RetirementSettings
  asOf: Month
  /** The people the plan counts, oldest profile first. */
  people: RetirementPerson[]
  /** Profiles that are not counted, with why. */
  skipped: RetirementSkipped[]
  /**
   * The person who retires last. The household is fully retired then, and the ages in the
   * projection and on the added costs are theirs. Null with no one in the plan.
   */
  reference: { memberId: string; name: string } | null
  /** The reference person's retirement age; null with no one in the plan. */
  targetAge: number | null
  /** What the people counted earn a year today, summed. */
  householdIncome: number
  /** The retirement accounts being projected and what each is worth now. */
  accounts: RetirementAccountValue[]
  /** What those accounts are worth now, integer cents. */
  startingBalance: number
  /** Why there is no projection yet; null once there is one. */
  problem: string | null
  /** Months from `asOf` until the last person retires; 0 when everyone already has. */
  monthsToTarget: number | null
  /** The portfolio when the last person retires, in today's dollars; null with no projection. */
  projected: number | null
  /** Contributed by everyone between now and the date they each retire. */
  contributed: number
  /** `projected` less what was there and what was contributed: what the market adds. */
  growth: number
  /** The yearly return left after inflation, in percent. */
  realReturn: number
  /** Oldest first: now, every year after, and the date the last person retires. */
  points: RetirementPoint[]
  /**
   * What went into retirement accounts by transfer over the 12 months ending `asOf`, per
   * month. Payroll deductions never show as transfers, so it is a floor, not a measure.
   */
  recentMonthlyContribution: number
}

export interface RetirementApi {
  /** The saved market assumptions, or the defaults before any are saved. */
  getRetirementSettings(): Promise<RetirementSettings>
  setRetirementSettings(settings: RetirementSettings): Promise<RetirementSettings>
  /**
   * Projects the retirement accounts (IRAs, 401(k)s and the other retirement plans, not
   * closed) to the month the last person in the plan retires. Each person's contribution
   * lands every month until they retire themselves, and the portfolio grows at the return
   * after inflation, so every figure is in today's dollars. Each account starts at its
   * value at the end of `asOf`. Assumes steady returns; a bad decade is not modeled.
   */
  getRetirementProjection(input: { asOf: Month }): Promise<RetirementProjection>
}

export function shiftMonth(month: Month, by: number): Month {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** Whole months from `from` to `to`; negative when `to` is earlier. */
export const monthsFrom = (from: Month, to: Month) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
  (Number(to.slice(5, 7)) - Number(from.slice(5, 7)))

/** Pure: the yearly return after inflation, in percent. */
export const realReturnRate = (returnRate: number, inflationRate: number) =>
  ((1 + returnRate / 100) / (1 + inflationRate / 100) - 1) * 100

/** One person's contributions in `projectHousehold`. */
export interface Contributor {
  /** Cents a month in today's dollars. */
  monthly: number
  /** Contributes in this many months from now, then stops. */
  months: number
  /** Percent a year the contribution grows after inflation, stepping on each anniversary. */
  realGrowth: number
}

/**
 * Pure: the balance month by month with any number of contributors, each stopping at their own
 * retirement. A contribution lands at the end of each month, after that month's growth. Money is
 * held as integer cents only at the edges; the months between are floating point, so the result is
 * an estimate by nature, but the same on every device.
 */
export function projectHousehold(input: {
  start: number
  contributors: readonly Contributor[]
  /** Percent a year, after inflation. */
  realReturn: number
  months: number
  /** The month `0` months from now falls in. */
  from: Month
  /** Age in months at `from`. */
  ageMonths: number
}): RetirementPoint[] {
  const monthly = Math.pow(1 + input.realReturn / 100, 1 / 12) - 1
  const points: RetirementPoint[] = []
  let balance = input.start
  let contributed = 0
  for (let i = 0; i <= input.months; i++) {
    if (i > 0) {
      balance *= 1 + monthly
      for (const c of input.contributors) {
        if (i > c.months) continue
        const amount =
          c.realGrowth === 0
            ? c.monthly
            : c.monthly * Math.pow(1 + c.realGrowth / 100, Math.floor((i - 1) / 12))
        balance += amount
        contributed += amount
      }
    }
    if (i % 12 === 0 || i === input.months) {
      points.push({
        month: shiftMonth(input.from, i),
        age: Math.round(((input.ageMonths + i) * 100) / 12) / 100,
        balance: Math.round(balance),
        contributed: Math.round(contributed),
      })
    }
  }
  return points
}

/** Pure: one person's balance, contributing the same amount until the end. */
export function projectRetirement(input: {
  start: number
  monthlyContribution: number
  /** Percent a year, after inflation. */
  realReturn: number
  months: number
  /** The month `0` months from now falls in. */
  from: Month
  /** Age in months at `from`. */
  ageMonths: number
}): RetirementPoint[] {
  return projectHousehold({
    start: input.start,
    contributors: [{ monthly: input.monthlyContribution, months: input.months, realGrowth: 0 }],
    realReturn: input.realReturn,
    months: input.months,
    from: input.from,
    ageMonths: input.ageMonths,
  })
}

function assertRange(value: number, range: { min: number; max: number }, what: string) {
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new Error(`${what} must be from ${range.min} to ${range.max}`)
  }
}

/** The saved market assumptions, or the defaults before any are saved. */
export async function readRetirementSettings(db: SqlRunner): Promise<RetirementSettings> {
  const [row] = await db.query<{
    return_rate: number
    inflation_rate: number
    withdrawal_rate: number
    lookback_months: number
  }>('SELECT * FROM retirement_assumptions ORDER BY created_at, id LIMIT 1')
  if (!row) return DEFAULT_RETIREMENT_SETTINGS
  return {
    returnRate: row.return_rate,
    inflationRate: row.inflation_rate,
    withdrawalRate: row.withdrawal_rate,
    lookbackMonths: row.lookback_months,
  }
}

/** See `RetirementApi.getRetirementProjection`. */
export async function loadRetirementProjection(
  tx: SqlRunner,
  asOf: Month,
): Promise<RetirementProjection> {
  const settings = await readRetirementSettings(tx)
  const kinds = RETIREMENT_KINDS.map(() => '?').join(', ')
  const included = new Set(
    (
      await tx.query<{ id: string }>(
        `SELECT i.id FROM investment_accounts i JOIN accounts a ON a.id = i.id
         WHERE a.closed = 0 AND i.kind IN (${kinds})`,
        [...RETIREMENT_KINDS],
      )
    ).map((r) => r.id),
  )
  const accounts = (await loadAccountHistories(tx, asOf))
    .filter((a) => included.has(a.accountId))
    .map((a) => ({ accountId: a.accountId, name: a.name, value: valueAtMonthEnd(a, asOf) }))
  const startingBalance = accounts.reduce((n, a) => n + a.value, 0)

  const [recent] = await tx.query<{ total: number }>(
    `SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t
     JOIN transactions p ON p.transfer_pair_id = t.transfer_pair_id AND p.id <> t.id
     JOIN accounts pa ON pa.id = p.account_id
     WHERE t.account_id IN (${[...included].map(() => '?').join(', ') || "''"})
       AND t.amount > 0 AND pa.type <> 'investment'
       AND substr(t.date, 1, 7) BETWEEN ? AND ?`,
    [...included, shiftMonth(asOf, -11), asOf],
  )

  const realReturn = realReturnRate(settings.returnRate, settings.inflationRate)
  const profiles = await readProfiles(tx)
  const people: RetirementPerson[] = profiles
    .filter((p) => p.plan.included && p.birthMonth !== null)
    .map((p) => {
      const birthMonth = p.birthMonth!
      const ageMonths = monthsFrom(birthMonth, asOf)
      return {
        ...p,
        memberId: p.id,
        name: p.displayName,
        birthMonth,
        retirementMonth: shiftMonth(birthMonth, p.retirementAge * 12),
        ageMonths,
        monthsToRetire: Math.max(p.retirementAge * 12 - ageMonths, 0),
        contributionGrowth: p.contributionFollowsRaises
          ? realReturnRate(p.incomeGrowth, settings.inflationRate)
          : 0,
      }
    })
  // The last to retire sets the date; the earlier profile wins a tie.
  const reference = people.reduce<RetirementPerson | null>(
    (best, p) => (best === null || p.retirementMonth > best.retirementMonth ? p : best),
    null,
  )
  const base = {
    settings,
    asOf,
    people,
    skipped: profiles
      .filter((p) => !p.plan.included)
      .map((p) => ({ memberId: p.id, name: p.displayName, note: p.plan.note ?? '' })),
    reference: reference && { memberId: reference.memberId, name: reference.name },
    targetAge: reference?.retirementAge ?? null,
    householdIncome: people.reduce((n, p) => n + p.annualIncome, 0),
    accounts,
    startingBalance,
    realReturn,
    recentMonthlyContribution: Math.round((recent?.total ?? 0) / 12),
    monthsToTarget: null,
    projected: null,
    contributed: 0,
    growth: 0,
    points: [],
  }
  if (reference === null) {
    return {
      ...base,
      problem: 'Add a birth month to a profile (Settings, Profiles) to see a projection.',
    }
  }
  const future = people.find((p) => p.ageMonths < 0)
  if (future) return { ...base, problem: `${future.name}’s birth month is in the future.` }
  const monthsToTarget = Math.max(...people.map((p) => p.monthsToRetire))
  const points = projectHousehold({
    start: startingBalance,
    contributors: people.map((p) => ({
      monthly: p.monthlyContribution,
      months: p.monthsToRetire,
      realGrowth: p.contributionGrowth,
    })),
    realReturn,
    months: monthsToTarget,
    from: asOf,
    ageMonths: reference.ageMonths,
  })
  const last = points[points.length - 1]!
  return {
    ...base,
    problem: null,
    monthsToTarget,
    projected: last.balance,
    contributed: last.contributed,
    growth: last.balance - startingBalance - last.contributed,
    points,
  }
}

export function retirementApi({ adapter, now, changes: log }: CrudDeps): RetirementApi {
  const ROW_ID = 'retirement'

  return {
    getRetirementSettings: () => readRetirementSettings(adapter),

    async setRetirementSettings(settings) {
      assertRange(settings.returnRate, RETURN_RATE_RANGE, 'The return')
      assertRange(settings.inflationRate, INFLATION_RATE_RANGE, 'Inflation')
      assertRange(settings.withdrawalRate, WITHDRAWAL_RATE_RANGE, 'The withdrawal rate')
      if (!Number.isInteger(settings.lookbackMonths)) {
        throw new Error('The spending lookback is a whole number of months')
      }
      assertRange(settings.lookbackMonths, LOOKBACK_RANGE, 'The spending lookback')
      const saved: RetirementSettings = {
        returnRate: Math.round(settings.returnRate * 100) / 100,
        inflationRate: Math.round(settings.inflationRate * 100) / 100,
        withdrawalRate: Math.round(settings.withdrawalRate * 100) / 100,
        lookbackMonths: settings.lookbackMonths,
      }
      await adapter.transaction(async (tx) => {
        const columns = {
          return_rate: saved.returnRate,
          inflation_rate: saved.inflationRate,
          withdrawal_rate: saved.withdrawalRate,
          lookback_months: saved.lookbackMonths,
        }
        const [stored] = await tx.query<{ id: string }>(
          'SELECT id FROM retirement_assumptions ORDER BY created_at, id LIMIT 1',
        )
        if (stored) await log(tx).update('retirement_assumptions', stored.id, columns)
        else {
          await log(tx).insert('retirement_assumptions', {
            id: ROW_ID,
            // the person's own facts moved to their profile (migration 21); these two columns
            // are still required by the table and are never read
            target_age: TARGET_AGE_RANGE.default,
            monthly_contribution: 0,
            ...columns,
            created_at: now(),
          })
        }
      })
      return saved
    },

    async getRetirementProjection({ asOf }) {
      assertMonth(asOf)
      return adapter.transaction((tx) => loadRetirementProjection(tx, asOf))
    },
  }
}
