import { assertMonth, type Month } from './allocations.ts'
import type { CrudDeps } from './crud.ts'
import type { SqlRunner } from './storage.ts'

/** What was spent in one month, split by whether it was a need or a want. */
export interface NeedsWantsMonth {
  month: Month
  /** Integer cents, positive; refunds net against spending. */
  need: number
  want: number
}

/** The average month over the last `window` months up to and including the report's month. */
export interface NeedsWantsAverage {
  window: number
  /**
   * How many months the average is over. Less than `window` when the budget's spending
   * history starts later, so a new budget isn't averaged against months before it existed.
   */
  months: number
  /** Integer cents per month, rounded to the nearest cent. */
  need: number
  want: number
}

export interface NeedsWantsReport {
  /** Oldest first, ending with the report's month; months with no spending are zero. */
  months: NeedsWantsMonth[]
  averages: NeedsWantsAverage[]
}

export interface ReportsApi {
  /**
   * Spending on needs and wants for `months` months (default 12) ending with `month`, and
   * the average month over the trailing 3, 6 and 12. A split counts as its own tag when it
   * has one, else its category's. Only categorized spending from on-budget accounts counts,
   * including goal draw-downs and money sent to tracking accounts under a category.
   * With `categoryId` only that category's lines count, and "history" starts at that
   * category's first spending.
   */
  getNeedsWantsReport(input: {
    month: Month
    months?: number
    categoryId?: string
  }): Promise<NeedsWantsReport>
}

export const AVERAGE_WINDOWS = [3, 6, 12] as const

function shift(month: Month, by: number): Month {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

const monthsBetween = (from: Month, to: Month) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
  (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) +
  1

/**
 * Pure: the average month over the `window` months ending at `month`. When the spending
 * history (`first`, the earliest month with any) starts inside the window, it averages
 * over the months since then, so a new budget isn't averaged against months before it existed.
 */
export function averageNeedsWants(
  spent: ReadonlyMap<Month, { need: number; want: number }>,
  month: Month,
  window: number,
  first: Month | null,
): NeedsWantsAverage {
  const start = shift(month, 1 - window)
  const from = first !== null && first > start ? first : start
  const n = monthsBetween(from, month)
  if (first === null || n <= 0) return { window, months: 0, need: 0, want: 0 }
  let need = 0
  let want = 0
  for (let i = 0; i < n; i++) {
    const s = spent.get(shift(from, i))
    need += s?.need ?? 0
    want += s?.want ?? 0
  }
  return { window, months: n, need: Math.round(need / n), want: Math.round(want / n) }
}

/**
 * Pure: the series for the months ending at `month` and the trailing averages over it.
 * `spent` holds the months that had any spending; `first` is the earliest of them across
 * all history (which may be before the series starts), or null if there is none.
 */
export function needsWantsReport(
  spent: ReadonlyMap<Month, { need: number; want: number }>,
  month: Month,
  count: number,
  first: Month | null,
): NeedsWantsReport {
  const months: NeedsWantsMonth[] = []
  for (let i = count - 1; i >= 0; i--) {
    const m = shift(month, -i)
    months.push({ month: m, need: spent.get(m)?.need ?? 0, want: spent.get(m)?.want ?? 0 })
  }
  const averages = AVERAGE_WINDOWS.map((window) => averageNeedsWants(spent, month, window, first))
  return { months, averages }
}

/**
 * Categorized spending per month through `month`, and the earliest month that had any.
 * `categoryId` narrows it to one category's lines.
 */
export async function loadSpending(db: SqlRunner, month: Month, categoryId?: string) {
  const rows = await db.query<{ month: string; tag: string; spent: number }>(
    `SELECT substr(t.date, 1, 7) AS month,
            COALESCE(s.need_or_want_override, c.need_or_want) AS tag,
            -SUM(s.amount) AS spent
     FROM transaction_splits s
     JOIN transactions t ON t.id = s.transaction_id
     JOIN accounts a ON a.id = t.account_id
     JOIN categories c ON c.id = s.category_id
     WHERE a.on_budget = 1 AND substr(t.date, 1, 7) <= ?
       AND (? IS NULL OR s.category_id = ?)
     GROUP BY month, tag`,
    [month, categoryId ?? null, categoryId ?? null],
  )
  const spent = new Map<Month, { need: number; want: number }>()
  let first: Month | null = null
  for (const r of rows) {
    const entry = spent.get(r.month) ?? { need: 0, want: 0 }
    spent.set(r.month, entry)
    if (r.tag === 'need') entry.need += r.spent
    else entry.want += r.spent
    if (first === null || r.month < first) first = r.month
  }
  return { spent, first }
}

export function reportsApi({ adapter }: CrudDeps): ReportsApi {
  return {
    async getNeedsWantsReport({ month, months = 12, categoryId }) {
      assertMonth(month)
      if (!Number.isInteger(months) || months < 1 || months > 120) {
        throw new Error('Pick between 1 and 120 months')
      }
      const { spent, first } = await loadSpending(adapter, month, categoryId)
      return needsWantsReport(spent, month, months, first)
    },
  }
}
