import { cents } from './money.ts'
import type { CrudDeps } from './crud.ts'
import type { SqlRunner } from './storage.ts'

export const ALLOCATION_SOURCES = ['manual', 'rule', 'move', 'contribution'] as const
export type AllocationSource = (typeof ALLOCATION_SOURCES)[number]

/** A calendar month as `YYYY-MM`. */
export type Month = string

/** One entry in the budgeting ledger. Entries are never edited: a correction is a new entry. */
export interface Allocation {
  id: string
  month: Month
  categoryId: string
  goalId: string | null
  /** Integer cents; negative takes money out of the category. */
  amount: number
  source: AllocationSource
  note: string | null
  createdAt: string
}

export interface CategoryBalance {
  categoryId: string
  /** Net allocations dated this month. */
  assigned: number
  /** Net of this month's spending (negative) and refunds (positive) from on-budget accounts. */
  activity: number
  /**
   * What the envelope holds at the end of this month. A month starts with the previous
   * month's available when that was positive; cash overspending does not carry (it is
   * taken from Ready to Assign instead), so a category never starts a month negative.
   */
  available: number
}

export interface AllocationsApi {
  /** Adds (or, if negative, removes) money from a category's month. */
  allocate(input: {
    month: Month
    categoryId: string
    amount: number
    note?: string
  }): Promise<Allocation>
  /** Moves money between categories as a pair of ledger entries. */
  moveAllocation(input: {
    month: Month
    fromCategoryId: string
    toCategoryId: string
    /** Positive cents. */
    amount: number
    note?: string
  }): Promise<[out: Allocation, into: Allocation]>
  /** Ledger entries, oldest first. */
  listAllocations(filter?: { month?: Month; categoryId?: string }): Promise<Allocation[]>
  /** Assigned, activity and available for every category, in display order. */
  getMonthBalances(month: Month): Promise<CategoryBalance[]>
  /**
   * Income through the end of `month` that no envelope holds yet. Cash overspending in an
   * earlier month comes out of it; overspending in `month` itself shows up next month.
   * Negative means more is assigned than exists.
   */
  getReadyToAssign(month: Month): Promise<number>
}

interface AllocationRow {
  id: string
  month: string
  category_id: string
  goal_id: string | null
  amount: number
  source: AllocationSource
  note: string | null
  created_at: string
}

const toAllocation = (r: AllocationRow): Allocation => ({
  id: r.id,
  month: r.month,
  categoryId: r.category_id,
  goalId: r.goal_id,
  amount: r.amount,
  source: r.source,
  note: r.note,
  createdAt: r.created_at,
})

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export function assertMonth(month: string): void {
  if (!MONTH.test(month)) throw new Error(`"${month}" is not a month (expected YYYY-MM)`)
}

function assertAmount(amount: number): void {
  try {
    cents(amount)
  } catch {
    throw new Error('Amount must be a whole number of cents')
  }
  if (amount === 0) throw new Error('Amount cannot be zero')
}

async function assertCategoryExists(db: SqlRunner, id: string) {
  const [row] = await db.query('SELECT 1 AS x FROM categories WHERE id = ?', [id])
  if (!row) throw new Error('Category not found')
}

const cleanNote = (note: string | undefined) => note?.trim() || null

interface Rolled {
  assigned: number
  activity: number
  available: number
  /** Cash overspending left behind by months before the one asked for. */
  overspent: number
}

/**
 * Rolls every category forward month by month up to `month`. A month opens with the last
 * month's available if it was positive; if it was negative the shortfall is counted as
 * overspent (it reduces Ready to Assign) and the category starts again from zero. Months
 * with no entries cannot overspend, so only months that have rows need visiting.
 */
async function rollCategories(db: SqlRunner, month: Month): Promise<Map<string, Rolled>> {
  // Activity counts only splits that carry a category, on on-budget accounts, plus the
  // card purchases and payments that flow through each credit card's payment category.
  const rows = await db.query<{
    category_id: string
    month: string
    assigned: number
    activity: number
  }>(
    `SELECT category_id, month, SUM(assigned) AS assigned, SUM(activity) AS activity FROM (
       SELECT category_id, month, amount AS assigned, 0 AS activity
         FROM allocations WHERE month <= ?1
       UNION ALL
       SELECT s.category_id, substr(t.date, 1, 7), 0, s.amount
         FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
         JOIN accounts a ON a.id = t.account_id
         WHERE s.category_id IS NOT NULL AND a.on_budget = 1 AND substr(t.date, 1, 7) <= ?1
       UNION ALL
       -- A card purchase moves its amount into the card's payment category; a refund takes
       -- it back out.
       SELECT pc.id, substr(t.date, 1, 7), 0, -s.amount
         FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
         JOIN accounts a ON a.id = t.account_id
         JOIN categories pc ON pc.credit_card_account_id = a.id
         WHERE s.category_id IS NOT NULL AND a.on_budget = 1 AND substr(t.date, 1, 7) <= ?1
       UNION ALL
       -- A payment (a transfer into the card) draws the payment category down.
       SELECT pc.id, substr(t.date, 1, 7), 0, -t.amount
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN categories pc ON pc.credit_card_account_id = a.id
         WHERE t.transfer_pair_id IS NOT NULL AND a.on_budget = 1 AND substr(t.date, 1, 7) <= ?1
     ) GROUP BY category_id, month ORDER BY category_id, month`,
    [month],
  )
  const out = new Map<string, Rolled>()
  for (const r of rows) {
    const cat = out.get(r.category_id) ?? { assigned: 0, activity: 0, available: 0, overspent: 0 }
    out.set(r.category_id, cat)
    const available = cat.available + r.assigned + r.activity
    if (r.month === month) {
      cat.assigned = r.assigned
      cat.activity = r.activity
      cat.available = available
    } else {
      cat.overspent += Math.max(-available, 0)
      cat.available = Math.max(available, 0)
    }
  }
  return out
}

export async function monthBalances(db: SqlRunner, month: Month): Promise<CategoryBalance[]> {
  assertMonth(month)
  const rolled = await rollCategories(db, month)
  const categories = await db.query<{ id: string }>(
    `SELECT c.id AS id FROM categories c JOIN category_groups g ON g.id = c.group_id
     ORDER BY g.sort, g.rowid, c.sort, c.rowid`,
  )
  return categories.map(({ id }) => {
    const r = rolled.get(id)
    return {
      categoryId: id,
      assigned: r?.assigned ?? 0,
      activity: r?.activity ?? 0,
      available: r?.available ?? 0,
    }
  })
}

export async function readyToAssign(db: SqlRunner, month: Month): Promise<number> {
  assertMonth(month)
  // Income is every uncategorized split on an on-budget account, so an uncategorized
  // outflow lowers it too.
  const [income] = await db.query<{ total: number }>(
    `SELECT COALESCE(SUM(s.amount), 0) AS total FROM transaction_splits s
       JOIN transactions t ON t.id = s.transaction_id
       JOIN accounts a ON a.id = t.account_id
       WHERE s.category_id IS NULL AND a.on_budget = 1 AND substr(t.date, 1, 7) <= ?`,
    [month],
  )
  const [assigned] = await db.query<{ total: number }>(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM allocations WHERE month <= ?',
    [month],
  )
  let overspent = 0
  for (const r of (await rollCategories(db, month)).values()) overspent += r.overspent
  return (income?.total ?? 0) - (assigned?.total ?? 0) - overspent
}

export function allocationsApi({ adapter, newId, now, changes: log }: CrudDeps): AllocationsApi {
  async function getAllocation(db: SqlRunner, id: string): Promise<Allocation> {
    const [row] = await db.query<AllocationRow & Record<string, never>>(
      'SELECT id, month, category_id, goal_id, amount, source, note, created_at FROM allocations WHERE id = ?',
      [id],
    )
    return toAllocation(row!)
  }

  async function insert(
    tx: SqlRunner,
    row: {
      month: Month
      categoryId: string
      amount: number
      source: AllocationSource
      note: string | null
    },
  ): Promise<Allocation> {
    const id = newId()
    await log(tx).insert('allocations', {
      id,
      month: row.month,
      category_id: row.categoryId,
      goal_id: null,
      amount: row.amount,
      source: row.source,
      note: row.note,
      created_at: now(),
    })
    return getAllocation(tx, id)
  }

  return {
    async allocate({ month, categoryId, amount, note }) {
      assertMonth(month)
      assertAmount(amount)
      return adapter.transaction(async (tx) => {
        await assertCategoryExists(tx, categoryId)
        return insert(tx, { month, categoryId, amount, source: 'manual', note: cleanNote(note) })
      })
    },
    async moveAllocation({ month, fromCategoryId, toCategoryId, amount, note }) {
      assertMonth(month)
      assertAmount(amount)
      if (amount < 0) throw new Error('Amount to move must be positive')
      if (fromCategoryId === toCategoryId) throw new Error('Pick two different categories')
      return adapter.transaction(async (tx) => {
        await assertCategoryExists(tx, fromCategoryId)
        await assertCategoryExists(tx, toCategoryId)
        const n = cleanNote(note)
        const out = await insert(tx, {
          month,
          categoryId: fromCategoryId,
          amount: -amount,
          source: 'move',
          note: n,
        })
        const into = await insert(tx, {
          month,
          categoryId: toCategoryId,
          amount,
          source: 'move',
          note: n,
        })
        return [out, into]
      })
    },
    async listAllocations(filter = {}) {
      if (filter.month !== undefined) assertMonth(filter.month)
      const where: string[] = []
      const params: string[] = []
      if (filter.month !== undefined) {
        where.push('month = ?')
        params.push(filter.month)
      }
      if (filter.categoryId !== undefined) {
        where.push('category_id = ?')
        params.push(filter.categoryId)
      }
      const rows = await adapter.query<AllocationRow & Record<string, never>>(
        `SELECT id, month, category_id, goal_id, amount, source, note, created_at FROM allocations
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`,
        params,
      )
      return rows.map(toAllocation)
    },
    getMonthBalances: (month) => adapter.transaction((tx) => monthBalances(tx, month)),
    getReadyToAssign: (month) => adapter.transaction((tx) => readyToAssign(tx, month)),
  }
}
