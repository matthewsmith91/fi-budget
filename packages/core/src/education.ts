import { assertMonth, type Month } from './allocations.ts'
import type { ChangeLog } from './changes.ts'
import { cleanName, type CrudDeps } from './crud.ts'
import { loadAccountHistories, valueAtMonthEnd } from './net-worth.ts'
import {
  INFLATION_RATE_RANGE,
  monthsFrom,
  projectRetirement,
  realReturnRate,
  RETURN_RATE_RANGE,
} from './retirement.ts'
import type { SqlRunner } from './storage.ts'
import { unitLedgerApi } from './unit-ledger.ts'

/** Typical starting points: a 529 invested for growth, and college costs rising faster than prices. */
export const EDUCATION_DEFAULTS = { returnRate: 6, inflationRate: 4 } as const

/** Saving for one child's education: a target amount in today's prices by a month. */
export interface EducationPlan {
  id: string
  /** Usually the child's name. */
  name: string
  /** The investment account (a 529, normally) the money is in; null counts as nothing saved. */
  accountId: string | null
  /** The goal inside that account that holds this child's share; null counts the whole account. */
  goalId: string | null
  /** What the education costs in today's prices, integer cents. */
  targetAmount: number
  /** The month the money is needed. */
  targetMonth: Month
  /** Cents a month going in, in today's dollars. */
  monthlyContribution: number
  /** Expected yearly return before cost increases, in percent. */
  returnRate: number
  /** Expected yearly rise in what the education costs, in percent. */
  inflationRate: number
}

export interface EducationPlanInput {
  name: string
  accountId?: string | null
  goalId?: string | null
  targetAmount: number
  targetMonth: Month
  monthlyContribution?: number
  returnRate?: number
  inflationRate?: number
}

export interface EducationPoint {
  month: Month
  /** In today's prices, integer cents. */
  balance: number
  /** Contributed from now until this point. */
  contributed: number
}

export interface EducationProjection {
  plan: EducationPlan
  /** What the plan holds at the end of `asOf`. */
  startingBalance: number
  /** Months from `asOf` to the target month; 0 once it has arrived. */
  monthsToTarget: number
  /** Where the plan stands at the target month, in today's prices. */
  projected: number
  /** `projected - targetAmount`; negative is a shortfall. */
  gap: number
  /** Whole percent of the target the projection reaches, rounded down. */
  percentFunded: number
  onTrack: boolean
  /** The monthly contribution that would reach the target on its own (instead of the planned one); 0 when the balance alone gets there. */
  monthlyNeeded: number
  /** Oldest first: now, every year after, and the target month. */
  points: EducationPoint[]
}

export interface EducationApi {
  listEducationPlans(): Promise<EducationPlan[]>
  /**
   * `goalId` needs `accountId` and means the child's share of a shared account: only that
   * goal's value counts as saved. Without it the whole account counts.
   */
  createEducationPlan(input: EducationPlanInput): Promise<EducationPlan>
  updateEducationPlan(id: string, changes: Partial<EducationPlanInput>): Promise<EducationPlan>
  deleteEducationPlan(id: string): Promise<void>
  /**
   * Projects each plan to its target month from what it holds at the end of `asOf`, with
   * the monthly contribution added and growth at the return after cost increases, so every
   * figure is in today's prices. A steady-return estimate, like the retirement projection.
   */
  getEducationProjections(input: { asOf: Month }): Promise<EducationProjection[]>
}

interface PlanRow {
  id: string
  name: string
  account_id: string | null
  goal_id: string | null
  target_amount: number
  target_month: string
  monthly_contribution: number
  return_rate: number
  inflation_rate: number
}

const toPlan = (r: PlanRow): EducationPlan => ({
  id: r.id,
  name: r.name,
  accountId: r.account_id,
  goalId: r.goal_id,
  targetAmount: r.target_amount,
  targetMonth: r.target_month,
  monthlyContribution: r.monthly_contribution,
  returnRate: r.return_rate,
  inflationRate: r.inflation_rate,
})

const PLAN_SELECT = `SELECT id, name, account_id, goal_id, target_amount, target_month,
  monthly_contribution, return_rate, inflation_rate FROM education_plans`

/**
 * Pure: the monthly contribution that makes `start` grow to `target` in `months` months at
 * `realReturn` percent a year, with each contribution landing after that month's growth, as
 * in `projectRetirement`. Rounded up to a cent; 0 when `start` alone gets there.
 */
export function monthlyNeededFor(input: {
  start: number
  target: number
  realReturn: number
  months: number
}): number {
  const { start, target, realReturn, months } = input
  if (months <= 0) return 0
  const g = Math.pow(1 + realReturn / 100, 1 / 12)
  const growth = Math.pow(g, months)
  const annuity = Math.abs(g - 1) < 1e-12 ? months : (growth - 1) / (g - 1)
  return Math.max(Math.ceil((target - start * growth) / annuity), 0)
}

function assertRate(value: number, range: { min: number; max: number }, what: string) {
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    throw new Error(`${what} must be from ${range.min} to ${range.max}`)
  }
}

/** Unlinks plans from an account or goal that is going away. */
export async function clearEducationLinks(
  db: SqlRunner,
  changes: ChangeLog,
  link: { accountId: string } | { goalId: string },
) {
  const rows =
    'accountId' in link
      ? await db.query<{ id: string }>('SELECT id FROM education_plans WHERE account_id = ?', [
          link.accountId,
        ])
      : await db.query<{ id: string }>('SELECT id FROM education_plans WHERE goal_id = ?', [
          link.goalId,
        ])
  for (const { id } of rows) {
    await changes.update(
      'education_plans',
      id,
      'accountId' in link ? { account_id: null, goal_id: null } : { goal_id: null },
    )
  }
}

export function educationApi(deps: CrudDeps): EducationApi {
  const { adapter, newId, now, changes: log } = deps

  async function getPlan(db: SqlRunner, id: string): Promise<EducationPlan> {
    const [row] = await db.query<PlanRow & Record<string, never>>(`${PLAN_SELECT} WHERE id = ?`, [
      id,
    ])
    if (!row) throw new Error('Plan not found')
    return toPlan(row)
  }

  async function assertLinks(db: SqlRunner, accountId: string | null, goalId: string | null) {
    if (accountId !== null) {
      const [account] = await db.query<{ type: string }>('SELECT type FROM accounts WHERE id = ?', [
        accountId,
      ])
      if (!account) throw new Error('Account not found')
      if (account.type !== 'investment') throw new Error('Pick an investment account, like a 529')
    }
    if (goalId !== null) {
      if (accountId === null) throw new Error('Pick the account that holds the goal’s money')
      const [goal] = await db.query('SELECT 1 AS x FROM goals WHERE id = ?', [goalId])
      if (!goal) throw new Error('Goal not found')
    }
  }

  function assertPlan(plan: Omit<EducationPlan, 'id'>) {
    if (!Number.isSafeInteger(plan.targetAmount) || plan.targetAmount <= 0) {
      throw new Error('The target must be a whole number of cents, more than zero')
    }
    assertMonth(plan.targetMonth)
    if (!Number.isSafeInteger(plan.monthlyContribution) || plan.monthlyContribution < 0) {
      throw new Error('The contribution is a whole number of cents, zero or more')
    }
    assertRate(plan.returnRate, RETURN_RATE_RANGE, 'The return')
    assertRate(plan.inflationRate, INFLATION_RATE_RANGE, 'The cost increase')
  }

  const columns = (p: Omit<EducationPlan, 'id'>) => ({
    name: p.name,
    account_id: p.accountId,
    goal_id: p.goalId,
    target_amount: p.targetAmount,
    target_month: p.targetMonth,
    monthly_contribution: p.monthlyContribution,
    return_rate: Math.round(p.returnRate * 100) / 100,
    inflation_rate: Math.round(p.inflationRate * 100) / 100,
  })

  return {
    async listEducationPlans() {
      const rows = await adapter.query<PlanRow & Record<string, never>>(
        `${PLAN_SELECT} ORDER BY created_at, id`,
      )
      return rows.map(toPlan)
    },

    async createEducationPlan(input) {
      const plan = {
        name: cleanName(input.name, 'Plan'),
        accountId: input.accountId ?? null,
        goalId: input.goalId ?? null,
        targetAmount: input.targetAmount,
        targetMonth: input.targetMonth,
        monthlyContribution: input.monthlyContribution ?? 0,
        returnRate: input.returnRate ?? EDUCATION_DEFAULTS.returnRate,
        inflationRate: input.inflationRate ?? EDUCATION_DEFAULTS.inflationRate,
      }
      assertPlan(plan)
      return adapter.transaction(async (tx) => {
        await assertLinks(tx, plan.accountId, plan.goalId)
        const id = newId()
        await log(tx).insert('education_plans', { id, ...columns(plan), created_at: now() })
        return getPlan(tx, id)
      })
    },

    async updateEducationPlan(id, changes) {
      return adapter.transaction(async (tx) => {
        const { id: _id, ...current } = await getPlan(tx, id)
        const next = {
          ...current,
          ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
        } as Omit<EducationPlan, 'id'>
        if (changes.name !== undefined) next.name = cleanName(changes.name, 'Plan')
        // moving to another account drops a goal that belonged to the old one
        if (changes.accountId !== undefined && changes.goalId === undefined) {
          if (changes.accountId !== current.accountId) next.goalId = null
        }
        assertPlan(next)
        await assertLinks(tx, next.accountId, next.goalId)
        await log(tx).update('education_plans', id, columns(next))
        return getPlan(tx, id)
      })
    },

    async deleteEducationPlan(id) {
      await adapter.transaction(async (tx) => {
        await getPlan(tx, id)
        await log(tx).delete('education_plans', id)
      })
    },

    async getEducationProjections({ asOf }) {
      assertMonth(asOf)
      const plans = await adapter.query<PlanRow & Record<string, never>>(
        `${PLAN_SELECT} ORDER BY created_at, id`,
      )
      const histories = await loadAccountHistories(adapter, asOf)
      const ledger = unitLedgerApi(deps)
      const shares = new Map<string, Map<string | null, number>>()
      for (const accountId of new Set(plans.filter((p) => p.goal_id).map((p) => p.account_id!))) {
        const { goals } = await ledger.getAccountInvestments(accountId)
        shares.set(accountId, new Map(goals.map((g) => [g.goalId, g.value])))
      }

      return plans.map((row) => {
        const plan = toPlan(row)
        const history = histories.find((h) => h.accountId === plan.accountId)
        const startingBalance =
          plan.goalId !== null
            ? (shares.get(plan.accountId!)?.get(plan.goalId) ?? 0)
            : history
              ? Math.max(valueAtMonthEnd(history, asOf), 0)
              : 0
        const monthsToTarget = Math.max(monthsFrom(asOf, plan.targetMonth), 0)
        const realReturn = realReturnRate(plan.returnRate, plan.inflationRate)
        const points = projectRetirement({
          start: startingBalance,
          monthlyContribution: plan.monthlyContribution,
          realReturn,
          months: monthsToTarget,
          from: asOf,
          ageMonths: 0,
        }).map(({ month, balance, contributed }) => ({ month, balance, contributed }))
        const projected = points[points.length - 1]!.balance
        return {
          plan,
          startingBalance,
          monthsToTarget,
          projected,
          gap: projected - plan.targetAmount,
          percentFunded: Math.max(Math.floor((projected * 100) / plan.targetAmount), 0),
          onTrack: projected >= plan.targetAmount,
          monthlyNeeded: monthlyNeededFor({
            start: startingBalance,
            target: plan.targetAmount,
            realReturn,
            months: monthsToTarget,
          }),
          points,
        }
      })
    },
  }
}
