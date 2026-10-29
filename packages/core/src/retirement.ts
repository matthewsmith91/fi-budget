import { assertMonth, type Month } from './allocations.ts'
import type { CrudDeps } from './crud.ts'
import type { InvestmentKind } from './investments.ts'
import { loadAccountHistories, valueAtMonthEnd } from './net-worth.ts'
import type { SqlRunner } from './storage.ts'

export const TARGET_AGE_RANGE = { min: 40, max: 90, default: 65 } as const
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

export interface RetirementSettings {
  /** The month the person the projection follows was born; null until entered. */
  birthMonth: Month | null
  /** The age to project to. */
  targetAge: number
  /** Cents a month going into retirement accounts, in today's dollars. */
  monthlyContribution: number
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
  birthMonth: null,
  targetAge: TARGET_AGE_RANGE.default,
  monthlyContribution: 0,
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

export interface RetirementProjection {
  settings: RetirementSettings
  asOf: Month
  /** The retirement accounts being projected and what each is worth now. */
  accounts: RetirementAccountValue[]
  /** What those accounts are worth now, integer cents. */
  startingBalance: number
  /** Why there is no projection yet; null once there is one. */
  problem: string | null
  /** Months from `asOf` to the target age; 0 when the person is already there. */
  monthsToTarget: number | null
  /** The portfolio at the target age, in today's dollars; null with no projection. */
  projected: number | null
  /** Contributed between now and the target age. */
  contributed: number
  /** `projected` less what was there and what was contributed: what the market adds. */
  growth: number
  /** The yearly return left after inflation, in percent. */
  realReturn: number
  /** Oldest first: now, every year after, and the target age. */
  points: RetirementPoint[]
  /**
   * What went into retirement accounts by transfer over the 12 months ending `asOf`, per
   * month. Payroll deductions never show as transfers, so it is a floor, not a measure.
   */
  recentMonthlyContribution: number
}

export interface RetirementApi {
  /** The saved assumptions, or the defaults with no birth month before any are saved. */
  getRetirementSettings(): Promise<RetirementSettings>
  setRetirementSettings(settings: RetirementSettings): Promise<RetirementSettings>
  /**
   * Projects the retirement accounts (IRAs, 401(k)s and the other retirement plans, not
   * closed) to the target age, adding the monthly contribution and growing at the return
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

/**
 * Pure: the balance month by month. The contribution lands at the end of each month, after
 * that month's growth. Money is held as integer cents only at the edges; the months between
 * are floating point, so the result is an estimate by nature, but the same on every device.
 */
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
  const monthly = Math.pow(1 + input.realReturn / 100, 1 / 12) - 1
  const points: RetirementPoint[] = []
  let balance = input.start
  for (let i = 0; i <= input.months; i++) {
    if (i > 0) balance = balance * (1 + monthly) + input.monthlyContribution
    if (i % 12 === 0 || i === input.months) {
      points.push({
        month: shiftMonth(input.from, i),
        age: Math.round(((input.ageMonths + i) * 100) / 12) / 100,
        balance: Math.round(balance),
        contributed: input.monthlyContribution * i,
      })
    }
  }
  return points
}

function assertRange(value: number, range: { min: number; max: number }, what: string) {
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new Error(`${what} must be from ${range.min} to ${range.max}`)
  }
}

/** The saved assumptions, or the defaults (no birth month) before any are saved. */
export async function readRetirementSettings(db: SqlRunner): Promise<RetirementSettings> {
  const [row] = await db.query<{
    birth_month: string | null
    target_age: number
    monthly_contribution: number
    return_rate: number
    inflation_rate: number
    withdrawal_rate: number
    lookback_months: number
  }>('SELECT * FROM retirement_assumptions ORDER BY created_at, id LIMIT 1')
  if (!row) return DEFAULT_RETIREMENT_SETTINGS
  return {
    birthMonth: row.birth_month,
    targetAge: row.target_age,
    monthlyContribution: row.monthly_contribution,
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
  const base = {
    settings,
    asOf,
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
  if (settings.birthMonth === null) {
    return { ...base, problem: 'Enter a birth month to see a projection.' }
  }
  const ageMonths = monthsFrom(settings.birthMonth, asOf)
  if (ageMonths < 0) return { ...base, problem: 'The birth month is in the future.' }
  const monthsToTarget = Math.max(settings.targetAge * 12 - ageMonths, 0)
  const points = projectRetirement({
    start: startingBalance,
    monthlyContribution: settings.monthlyContribution,
    realReturn,
    months: monthsToTarget,
    from: asOf,
    ageMonths,
  })
  const projected = points[points.length - 1]!.balance
  const contributed = settings.monthlyContribution * monthsToTarget
  return {
    ...base,
    problem: null,
    monthsToTarget,
    projected,
    contributed,
    growth: projected - startingBalance - contributed,
    points,
  }
}

export function retirementApi({ adapter, now, changes: log }: CrudDeps): RetirementApi {
  const ROW_ID = 'retirement'

  return {
    getRetirementSettings: () => readRetirementSettings(adapter),

    async setRetirementSettings(settings) {
      if (settings.birthMonth !== null) assertMonth(settings.birthMonth)
      if (!Number.isInteger(settings.targetAge)) throw new Error('The target age is a whole number')
      assertRange(settings.targetAge, TARGET_AGE_RANGE, 'The target age')
      if (!Number.isSafeInteger(settings.monthlyContribution) || settings.monthlyContribution < 0) {
        throw new Error('The contribution is a whole number of cents, zero or more')
      }
      assertRange(settings.returnRate, RETURN_RATE_RANGE, 'The return')
      assertRange(settings.inflationRate, INFLATION_RATE_RANGE, 'Inflation')
      assertRange(settings.withdrawalRate, WITHDRAWAL_RATE_RANGE, 'The withdrawal rate')
      if (!Number.isInteger(settings.lookbackMonths)) {
        throw new Error('The spending lookback is a whole number of months')
      }
      assertRange(settings.lookbackMonths, LOOKBACK_RANGE, 'The spending lookback')
      const saved: RetirementSettings = {
        ...settings,
        returnRate: Math.round(settings.returnRate * 100) / 100,
        inflationRate: Math.round(settings.inflationRate * 100) / 100,
        withdrawalRate: Math.round(settings.withdrawalRate * 100) / 100,
      }
      await adapter.transaction(async (tx) => {
        const columns = {
          birth_month: saved.birthMonth,
          target_age: saved.targetAge,
          monthly_contribution: saved.monthlyContribution,
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
