import { assertMonth, type Month } from './allocations.ts'
import { cleanName, type CrudDeps } from './crud.ts'
import { cents } from './money.ts'
import type { SqlRunner } from './storage.ts'
import { assertDate } from './transactions.ts'

/** A sinking fund inside a category, with its own balance, target and optional date. */
export interface Goal {
  id: string
  categoryId: string
  name: string
  /** Integer cents; always positive. */
  targetAmount: number
  /** `YYYY-MM-DD`, or null for a goal with no deadline. */
  targetDate: string | null
  /** An archived goal keeps its history but takes no more money or spending. */
  archived: boolean
  /** The budget account this goal's money sits in, or null if it isn't tied to one. */
  heldInAccountId: string | null
}

/**
 * Where a goal stands in a month. Allocations and spending that carry the goal's id are
 * the goal's own; they are also part of its category's assigned, activity and available.
 */
export interface GoalBalance {
  goalId: string
  categoryId: string
  /** Net allocations to the goal dated this month. */
  assigned: number
  /** Spending from the goal (negative) and refunds into it this month. */
  activity: number
  /**
   * What the goal holds at the end of the month: everything ever assigned plus spending,
   * through this month. Goals accumulate; they do not reset when a month ends.
   */
  available: number
  /** Whole percent of the target held, 0 to 100. Rounds down, so 100 means fully funded. */
  percentFunded: number
  /**
   * What to assign each month, this one included, to reach the target by the target date,
   * worked out from the balance at the start of the month. Null without a target date.
   */
  monthlyNeeded: number | null
  /** How much of `monthlyNeeded` is still unassigned this month. */
  underfunded: number
}

/**
 * What the goals held in one account add up to against what the account has. The goals'
 * balances are envelope money; if they total more than the account, some of it isn't there.
 */
export interface AccountHolding {
  accountId: string
  /** The account's balance through the end of the month, from every transaction in it. */
  balance: number
  /** The sum of the balances of the goals held in it, counting only goals that hold money. */
  held: number
  /** How much `held` exceeds `balance`; 0 when the account covers its goals. */
  over: number
  /** Each goal held in the account, with what it holds (negative if it is overspent). */
  goals: { goalId: string; amount: number }[]
}

export interface GoalsApi {
  /** Every goal, archived ones included, oldest first. */
  listGoals(): Promise<Goal[]>
  createGoal(input: {
    categoryId: string
    name: string
    targetAmount: number
    targetDate?: string | null
    /** A budget account (not a credit card) that holds the goal's money. */
    heldInAccountId?: string | null
  }): Promise<Goal>
  updateGoal(
    id: string,
    changes: {
      name?: string
      targetAmount?: number
      targetDate?: string | null
      heldInAccountId?: string | null
    },
  ): Promise<Goal>
  /**
   * Retires a goal. Whatever it still holds (or owes) returns to its category's unassigned
   * part in `month`, so the category total does not change. History stays.
   */
  archiveGoal(id: string, input: { month: Month }): Promise<Goal>
  unarchiveGoal(id: string): Promise<Goal>
  /** Only a goal with no history can be deleted; archive it to keep it. */
  deleteGoal(id: string): Promise<void>
  /** Every goal's balance and progress as of `month`. */
  getGoalBalances(month: Month): Promise<GoalBalance[]>
  /**
   * For every account that has goals held in it, how much those goals hold against the
   * account's balance, as of the end of `month`. Accounts with no goals are left out.
   * An entry with `over` above zero is the over-allocation warning.
   */
  getAccountHoldings(month: Month): Promise<AccountHolding[]>
}

interface GoalRow {
  id: string
  category_id: string
  name: string
  target_amount: number
  target_date: string | null
  archived: number
  held_in_account_id: string | null
}

const GOAL_SELECT =
  'SELECT id, category_id, name, target_amount, target_date, archived, held_in_account_id FROM goals'

const toGoal = (r: GoalRow): Goal => ({
  id: r.id,
  categoryId: r.category_id,
  name: r.name,
  targetAmount: r.target_amount,
  targetDate: r.target_date,
  archived: r.archived === 1,
  heldInAccountId: r.held_in_account_id,
})

async function getGoal(db: SqlRunner, id: string): Promise<Goal> {
  const [row] = await db.query<GoalRow & Record<string, never>>(`${GOAL_SELECT} WHERE id = ?`, [id])
  if (!row) throw new Error('Goal not found')
  return toGoal(row)
}

function assertTarget(amount: number) {
  try {
    cents(amount)
  } catch {
    throw new Error('Target must be a whole number of cents')
  }
  if (amount <= 0) throw new Error('Target must be more than zero')
}

/** Only a budget account that isn't a credit card can hold savings. */
async function assertCanHold(db: SqlRunner, accountId: string) {
  const [account] = await db.query<{ type: string; on_budget: number; closed: number }>(
    'SELECT type, on_budget, closed FROM accounts WHERE id = ?',
    [accountId],
  )
  if (!account) throw new Error('Account not found')
  if (account.type === 'credit' || account.on_budget !== 1) {
    throw new Error('A goal can only be held in a budget account that isn’t a credit card')
  }
  if (account.closed === 1) throw new Error('That account is closed')
}

async function assertNameFree(db: SqlRunner, categoryId: string, name: string, exceptId = '') {
  const [dup] = await db.query(
    `SELECT 1 AS x FROM goals
     WHERE category_id = ? AND name = ? COLLATE NOCASE AND archived = 0 AND id <> ?`,
    [categoryId, name, exceptId],
  )
  if (dup) throw new Error(`This category already has a goal named "${name}"`)
}

const monthIndex = (month: Month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1

/**
 * The monthly amount and funding progress for one goal. Pure: `available`, `assigned` and
 * `activity` are the goal's figures for `month`. The target month counts as a month to
 * fund, and a goal past its date needs the whole remainder now.
 */
export function goalProgress(
  goal: Pick<Goal, 'targetAmount' | 'targetDate'>,
  month: Month,
  figures: { assigned: number; activity: number; available: number },
): Pick<GoalBalance, 'percentFunded' | 'monthlyNeeded' | 'underfunded'> {
  const { targetAmount, targetDate } = goal
  const { assigned, activity, available } = figures
  const percentFunded = Math.min(Math.max(Math.floor((available * 100) / targetAmount), 0), 100)
  if (targetDate === null) return { percentFunded, monthlyNeeded: null, underfunded: 0 }
  const opening = available - assigned - activity
  const remaining = Math.max(targetAmount - opening, 0)
  const months = Math.max(monthIndex(targetDate.slice(0, 7)) - monthIndex(month) + 1, 1)
  const monthlyNeeded = Math.ceil(remaining / months)
  const underfunded = Math.min(
    Math.max(monthlyNeeded - assigned, 0),
    Math.max(targetAmount - available, 0),
  )
  return { percentFunded, monthlyNeeded, underfunded }
}

/**
 * Each goal's assigned and spending for `month`, and its balance through that month.
 * Spending counts only on-budget accounts, like a category's activity.
 */
async function goalFigures(db: SqlRunner, month: Month) {
  const rows = await db.query<{
    goal_id: string
    month: string
    assigned: number
    activity: number
  }>(
    `SELECT goal_id, month, SUM(assigned) AS assigned, SUM(activity) AS activity FROM (
       SELECT goal_id, month, amount AS assigned, 0 AS activity
         FROM allocations WHERE goal_id IS NOT NULL AND month <= ?1
       UNION ALL
       SELECT s.goal_id, substr(t.date, 1, 7), 0, s.amount
         FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
         JOIN accounts a ON a.id = t.account_id
         WHERE s.goal_id IS NOT NULL AND a.on_budget = 1 AND substr(t.date, 1, 7) <= ?1
     ) GROUP BY goal_id, month`,
    [month],
  )
  const out = new Map<string, { assigned: number; activity: number; available: number }>()
  for (const r of rows) {
    const g = out.get(r.goal_id) ?? { assigned: 0, activity: 0, available: 0 }
    out.set(r.goal_id, g)
    g.available += r.assigned + r.activity
    if (r.month === month) {
      g.assigned = r.assigned
      g.activity = r.activity
    }
  }
  return out
}

export function goalsApi({ adapter, newId, now, changes: log }: CrudDeps): GoalsApi {
  return {
    async listGoals() {
      const rows = await adapter.query<GoalRow & Record<string, never>>(
        `${GOAL_SELECT} ORDER BY created_at, id`,
      )
      return rows.map(toGoal)
    },

    async createGoal({ categoryId, name, targetAmount, targetDate, heldInAccountId }) {
      const clean = cleanName(name, 'Goal')
      assertTarget(targetAmount)
      if (targetDate) assertDate(targetDate)
      return adapter.transaction(async (tx) => {
        const [category] = await tx.query<{ credit_card_account_id: string | null }>(
          'SELECT credit_card_account_id FROM categories WHERE id = ?',
          [categoryId],
        )
        if (!category) throw new Error('Category not found')
        if (category.credit_card_account_id) {
          throw new Error('A credit card payment category can’t hold goals')
        }
        await assertNameFree(tx, categoryId, clean)
        if (heldInAccountId) await assertCanHold(tx, heldInAccountId)
        const id = newId()
        await log(tx).insert('goals', {
          id,
          category_id: categoryId,
          name: clean,
          target_amount: targetAmount,
          target_date: targetDate || null,
          archived: 0,
          held_in_account_id: heldInAccountId || null,
          created_at: now(),
        })
        return getGoal(tx, id)
      })
    },

    async updateGoal(id, patch) {
      if (patch.targetAmount !== undefined) assertTarget(patch.targetAmount)
      if (patch.targetDate) assertDate(patch.targetDate)
      return adapter.transaction(async (tx) => {
        const current = await getGoal(tx, id)
        const name = patch.name === undefined ? current.name : cleanName(patch.name, 'Goal')
        if (name !== current.name && !current.archived) {
          await assertNameFree(tx, current.categoryId, name, id)
        }
        const heldIn =
          patch.heldInAccountId === undefined
            ? current.heldInAccountId
            : patch.heldInAccountId || null
        // Keeping the account it already has is always fine, even if that account has closed since.
        if (heldIn && heldIn !== current.heldInAccountId) await assertCanHold(tx, heldIn)
        await log(tx).update('goals', id, {
          name,
          target_amount: patch.targetAmount ?? current.targetAmount,
          target_date:
            patch.targetDate === undefined ? current.targetDate : patch.targetDate || null,
          held_in_account_id: heldIn,
        })
        return getGoal(tx, id)
      })
    },

    async archiveGoal(id, { month }) {
      assertMonth(month)
      return adapter.transaction(async (tx) => {
        const current = await getGoal(tx, id)
        if (current.archived) return current
        // Through the latest possible month: everything the goal ever held, whenever dated.
        const held = (await goalFigures(tx, '9999-12')).get(id)?.available ?? 0
        const changes = log(tx)
        if (held !== 0) {
          // Hand what the goal holds (or owes) back to the category's unassigned part.
          const at = now()
          const note = `Archived goal “${current.name}”`
          for (const [goalId, amount] of [
            [id, -held],
            [null, held],
          ] as const) {
            await changes.insert('allocations', {
              id: newId(),
              month,
              category_id: current.categoryId,
              goal_id: goalId,
              amount,
              source: 'move',
              note,
              created_at: at,
            })
          }
        }
        await changes.update('goals', id, { archived: 1 })
        return getGoal(tx, id)
      })
    },

    async unarchiveGoal(id) {
      return adapter.transaction(async (tx) => {
        const current = await getGoal(tx, id)
        await assertNameFree(tx, current.categoryId, current.name, id)
        await log(tx).update('goals', id, { archived: 0 })
        return getGoal(tx, id)
      })
    },

    async deleteGoal(id) {
      await adapter.transaction(async (tx) => {
        await getGoal(tx, id)
        const [used] = await tx.query(
          `SELECT 1 AS x FROM allocations WHERE goal_id = ?
           UNION ALL SELECT 1 FROM transaction_splits WHERE goal_id = ? LIMIT 1`,
          [id, id],
        )
        if (used) throw new Error('This goal has history; archive it instead of deleting')
        await log(tx).delete('goals', id)
      })
    },

    async getAccountHoldings(month) {
      assertMonth(month)
      return adapter.transaction(async (tx) => {
        const goals = await tx.query<{ id: string; account_id: string }>(
          `SELECT id, held_in_account_id AS account_id FROM goals
           WHERE held_in_account_id IS NOT NULL ORDER BY created_at, id`,
        )
        if (goals.length === 0) return []
        const figures = await goalFigures(tx, month)
        const balances = await tx.query<{ account_id: string; balance: number }>(
          `SELECT account_id, SUM(amount) AS balance FROM transactions
           WHERE substr(date, 1, 7) <= ? GROUP BY account_id`,
          [month],
        )
        const balanceOf = new Map(balances.map((b) => [b.account_id, b.balance]))
        const byAccount = new Map<string, AccountHolding>()
        for (const g of goals) {
          const amount = figures.get(g.id)?.available ?? 0
          const entry = byAccount.get(g.account_id) ?? {
            accountId: g.account_id,
            balance: balanceOf.get(g.account_id) ?? 0,
            held: 0,
            over: 0,
            goals: [],
          }
          byAccount.set(g.account_id, entry)
          entry.goals.push({ goalId: g.id, amount })
          entry.held += Math.max(amount, 0)
        }
        return [...byAccount.values()].map((h) => ({
          ...h,
          over: Math.max(h.held - Math.max(h.balance, 0), 0),
        }))
      })
    },

    async getGoalBalances(month) {
      assertMonth(month)
      return adapter.transaction(async (tx) => {
        const goals = await tx.query<GoalRow & Record<string, never>>(
          `${GOAL_SELECT} ORDER BY created_at, id`,
        )
        const figures = await goalFigures(tx, month)
        return goals.map((row): GoalBalance => {
          const f = figures.get(row.id) ?? { assigned: 0, activity: 0, available: 0 }
          const goal = toGoal(row)
          return {
            goalId: goal.id,
            categoryId: goal.categoryId,
            ...f,
            ...goalProgress(goal, month, f),
          }
        })
      })
    },
  }
}
