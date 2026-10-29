import { assertMonth, type Month } from './allocations.ts'
import { cleanName, type CrudDeps } from './crud.ts'
import type { RetirementStatus } from './categories.ts'
import {
  loadRetirementProjection,
  readRetirementSettings,
  shiftMonth,
  type RetirementSettings,
} from './retirement.ts'
import type { SqlRunner } from './storage.ts'

/** A cost that doesn't exist today (health insurance before Medicare), in today's dollars. */
export interface RetirementFixedItem {
  id: string
  name: string
  /** Integer cents a year; always positive. */
  annualAmount: number
  /** It applies from this age; null from the start of retirement. */
  startAge: number | null
  /** It stops at this age (the birthday itself is no longer covered); null never stops. */
  endAge: number | null
}

export interface RetirementFixedItemInput {
  name: string
  annualAmount: number
  startAge?: number | null
  endAge?: number | null
}

/** One category's part of the retirement baseline. */
export interface RetirementSpendCategory {
  categoryId: string
  name: string
  status: RetirementStatus
  /** Only for `changes`. */
  multiplier: number | null
  /** What it averages a month today, integer cents. */
  monthly: number
  /** What it is expected to take a month in retirement: 0 for `ends`, scaled for `changes`. */
  retirementMonthly: number
  /** The portfolio this category needs at the withdrawal rate. */
  required: number
}

export interface RetirementFixedItemFigures extends RetirementFixedItem {
  /** Whether it applies at the target age, and so is counted in the annual spend. */
  active: boolean
}

/** Yearly spending from `fromAge` until the next step; the last step has no end. */
export interface RetirementSpendStep {
  fromAge: number
  toAge: number | null
  annual: number
}

export interface RetirementSpending {
  settings: RetirementSettings
  /** The last month the spending average runs through. */
  month: Month
  /** How many months the baseline averages; less than the lookback with a short history. */
  averagedMonths: number
  /** Categories that had spending, biggest in retirement first. */
  categories: RetirementSpendCategory[]
  /** Continues and Changes categories in retirement, per month. */
  baselineMonthly: number
  /** What the categories that end take a month today. */
  endingMonthly: number
  fixedItems: RetirementFixedItemFigures[]
  /** Fixed additions that apply at the target age, per year. */
  fixedAnnual: number
  /** Baseline × 12 + fixed additions at the target age, in today's dollars. */
  annualSpend: number
  /** The spend from the target age on, as fixed additions start and stop. */
  schedule: RetirementSpendStep[]
  /** Annual spend ÷ withdrawal rate; null with no spending history. */
  requiredPortfolio: number | null
  /** The projected portfolio at the target age; null until there is a projection. */
  projected: number | null
  /** Why `projected` is missing; null when it is there. */
  projectionProblem: string | null
  /** `projected - requiredPortfolio`; negative is a shortfall. */
  surplus: number | null
  /** Whole percent of the required portfolio the projection reaches, rounded down. */
  fundedPercent: number | null
  /** Null when there is no required portfolio or no projection to compare. */
  succeeds: boolean | null
  /** How much the required portfolio moves for each $100 a month of spending. */
  perHundredMonthly: number
}

export interface RetirementSpendingApi {
  listRetirementFixedItems(): Promise<RetirementFixedItem[]>
  createRetirementFixedItem(input: RetirementFixedItemInput): Promise<RetirementFixedItem>
  updateRetirementFixedItem(
    id: string,
    changes: Partial<RetirementFixedItemInput>,
  ): Promise<RetirementFixedItem>
  deleteRetirementFixedItem(id: string): Promise<void>
  /**
   * The annual spend in retirement and whether the projected portfolio covers it. The
   * baseline averages the real spending of the `lookbackMonths` ending with `month`: a
   * category that continues counts as is, one that changes by its multiplier, one that ends
   * not at all. Fixed additions that apply at the target age come on top. The portfolio
   * needed is the annual spend divided by the withdrawal rate; the projection is the
   * retirement projection starting from `asOf`. Everything is in today's dollars.
   */
  getRetirementSpending(input: { month: Month; asOf: Month }): Promise<RetirementSpending>
}

interface ItemRow {
  id: string
  name: string
  annual_amount: number
  start_age: number | null
  end_age: number | null
}

const toItem = (r: ItemRow): RetirementFixedItem => ({
  id: r.id,
  name: r.name,
  annualAmount: r.annual_amount,
  startAge: r.start_age,
  endAge: r.end_age,
})

const ITEM_SELECT = 'SELECT id, name, annual_amount, start_age, end_age FROM retirement_fixed_items'

/** Pure: whether an item applies at `age`. */
export const itemActiveAt = (
  item: Pick<RetirementFixedItem, 'startAge' | 'endAge'>,
  age: number,
): boolean =>
  (item.startAge === null || item.startAge <= age) && (item.endAge === null || age < item.endAge)

/** Pure: the yearly spend from `fromAge`, one step wherever a fixed item starts or stops. */
export function spendSchedule(
  baselineAnnual: number,
  items: readonly Pick<RetirementFixedItem, 'annualAmount' | 'startAge' | 'endAge'>[],
  fromAge: number,
): RetirementSpendStep[] {
  const breaks = new Set<number>()
  for (const item of items) {
    for (const age of [item.startAge, item.endAge])
      if (age !== null && age > fromAge) breaks.add(age)
  }
  const starts = [fromAge, ...[...breaks].sort((a, b) => a - b)]
  const steps: RetirementSpendStep[] = []
  for (const age of starts) {
    const annual =
      baselineAnnual +
      items.reduce((n, item) => n + (itemActiveAt(item, age) ? item.annualAmount : 0), 0)
    const last = steps[steps.length - 1]
    if (last && last.annual === annual) continue
    if (last) last.toAge = age
    steps.push({ fromAge: age, toAge: null, annual })
  }
  return steps
}

const monthsBetween = (from: Month, to: Month) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
  (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) +
  1

function assertAge(age: number | null | undefined, what: string) {
  if (age === null || age === undefined) return
  if (!Number.isInteger(age) || age < 0 || age > 120) {
    throw new Error(`${what} must be a whole number of years from 0 to 120`)
  }
}

function assertItem(item: {
  annualAmount: number
  startAge: number | null
  endAge: number | null
}) {
  if (!Number.isSafeInteger(item.annualAmount) || item.annualAmount <= 0) {
    throw new Error('The yearly amount must be a whole number of cents, more than zero')
  }
  assertAge(item.startAge, 'The start age')
  assertAge(item.endAge, 'The end age')
  if (item.startAge !== null && item.endAge !== null && item.endAge <= item.startAge) {
    throw new Error('The end age must be after the start age')
  }
}

export function retirementSpendingApi({
  adapter,
  newId,
  now,
  changes: log,
}: CrudDeps): RetirementSpendingApi {
  async function getItem(db: SqlRunner, id: string): Promise<RetirementFixedItem> {
    const [row] = await db.query<ItemRow & Record<string, never>>(`${ITEM_SELECT} WHERE id = ?`, [
      id,
    ])
    if (!row) throw new Error('Item not found')
    return toItem(row)
  }

  return {
    async listRetirementFixedItems() {
      const rows = await adapter.query<ItemRow & Record<string, never>>(
        `${ITEM_SELECT} ORDER BY created_at, id`,
      )
      return rows.map(toItem)
    },

    async createRetirementFixedItem(input) {
      const item = {
        name: cleanName(input.name, 'Item'),
        annualAmount: input.annualAmount,
        startAge: input.startAge ?? null,
        endAge: input.endAge ?? null,
      }
      assertItem(item)
      return adapter.transaction(async (tx) => {
        const id = newId()
        await log(tx).insert('retirement_fixed_items', {
          id,
          name: item.name,
          annual_amount: item.annualAmount,
          start_age: item.startAge,
          end_age: item.endAge,
          created_at: now(),
        })
        return getItem(tx, id)
      })
    },

    async updateRetirementFixedItem(id, changes) {
      return adapter.transaction(async (tx) => {
        const current = await getItem(tx, id)
        const next = {
          name: changes.name === undefined ? current.name : cleanName(changes.name, 'Item'),
          annualAmount: changes.annualAmount ?? current.annualAmount,
          startAge: changes.startAge === undefined ? current.startAge : changes.startAge,
          endAge: changes.endAge === undefined ? current.endAge : changes.endAge,
        }
        assertItem(next)
        await log(tx).update('retirement_fixed_items', id, {
          name: next.name,
          annual_amount: next.annualAmount,
          start_age: next.startAge,
          end_age: next.endAge,
        })
        return getItem(tx, id)
      })
    },

    async deleteRetirementFixedItem(id) {
      await adapter.transaction(async (tx) => {
        await getItem(tx, id)
        await log(tx).delete('retirement_fixed_items', id)
      })
    },

    async getRetirementSpending({ month, asOf }) {
      assertMonth(month)
      assertMonth(asOf)
      return adapter.transaction(async (tx) => {
        const settings = await readRetirementSettings(tx)
        const rate = settings.withdrawalRate

        // Net spending per category over the lookback, from on-budget accounts. The window
        // starts no earlier than the first month with any spending, so a new budget isn't
        // averaged against months before it existed.
        const [firstRow] = await tx.query<{ first: string | null }>(
          `SELECT MIN(substr(t.date, 1, 7)) AS first FROM transaction_splits s
           JOIN transactions t ON t.id = s.transaction_id
           JOIN accounts a ON a.id = t.account_id
           WHERE s.category_id IS NOT NULL AND a.on_budget = 1 AND substr(t.date, 1, 7) <= ?`,
          [month],
        )
        const windowStart = shiftMonth(month, 1 - settings.lookbackMonths)
        const first = firstRow?.first ?? null
        const from = first !== null && first > windowStart ? first : windowStart
        const averagedMonths = first === null ? 0 : Math.max(monthsBetween(from, month), 0)

        const rows =
          averagedMonths === 0
            ? []
            : await tx.query<{
                id: string
                name: string
                status: RetirementStatus
                multiplier: number | null
                spent: number
              }>(
                `SELECT c.id AS id, c.name AS name, c.retirement_status AS status,
                        c.retirement_multiplier AS multiplier, -SUM(s.amount) AS spent
                 FROM transaction_splits s
                 JOIN transactions t ON t.id = s.transaction_id
                 JOIN accounts a ON a.id = t.account_id
                 JOIN categories c ON c.id = s.category_id
                 WHERE a.on_budget = 1 AND c.credit_card_account_id IS NULL
                   AND substr(t.date, 1, 7) BETWEEN ? AND ?
                 GROUP BY c.id`,
                [from, month],
              )

        const categories: RetirementSpendCategory[] = rows
          .filter((r) => r.spent > 0)
          .map((r) => {
            const monthly = Math.round(r.spent / averagedMonths)
            const multiplier = r.status === 'changes' ? (r.multiplier ?? 1) : null
            const retirementMonthly =
              r.status === 'ends' ? 0 : Math.round(monthly * (multiplier ?? 1))
            return {
              categoryId: r.id,
              name: r.name,
              status: r.status,
              multiplier,
              monthly,
              retirementMonthly,
              required: Math.round((retirementMonthly * 12 * 100) / rate),
            }
          })
          .sort((a, b) => b.retirementMonthly - a.retirementMonthly || a.name.localeCompare(b.name))

        const baselineMonthly = categories.reduce((n, c) => n + c.retirementMonthly, 0)
        const endingMonthly = categories
          .filter((c) => c.status === 'ends')
          .reduce((n, c) => n + c.monthly, 0)

        const items = (
          await tx.query<ItemRow & Record<string, never>>(`${ITEM_SELECT} ORDER BY created_at, id`)
        ).map(toItem)
        const fixedItems = items.map((i) => ({ ...i, active: itemActiveAt(i, settings.targetAge) }))
        const fixedAnnual = fixedItems.reduce((n, i) => n + (i.active ? i.annualAmount : 0), 0)
        const annualSpend = baselineMonthly * 12 + fixedAnnual

        const projection = await loadRetirementProjection(tx, asOf)
        const requiredPortfolio = annualSpend > 0 ? Math.round((annualSpend * 100) / rate) : null
        const projected = projection.projected
        const comparable = requiredPortfolio !== null && projected !== null
        return {
          settings,
          month,
          averagedMonths,
          categories,
          baselineMonthly,
          endingMonthly,
          fixedItems,
          fixedAnnual,
          annualSpend,
          schedule: spendSchedule(baselineMonthly * 12, items, settings.targetAge),
          requiredPortfolio,
          projected,
          projectionProblem: projection.problem,
          surplus: comparable ? projected - requiredPortfolio : null,
          fundedPercent: comparable ? Math.floor((projected * 100) / requiredPortfolio) : null,
          succeeds: comparable ? projected >= requiredPortfolio : null,
          perHundredMonthly: Math.round((100_00 * 12 * 100) / rate),
        }
      })
    },
  }
}
