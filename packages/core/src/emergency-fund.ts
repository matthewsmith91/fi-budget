import { assertMonth, monthBalances, type Month } from './allocations.ts'
import type { CrudDeps } from './crud.ts'
import { averageNeedsWants, loadSpending } from './reports.ts'
import type { SqlRunner } from './storage.ts'

export const COVERAGE_RANGE = { min: 1, max: 24, default: 6 } as const
export const WINDOW_RANGE = { min: 3, max: 12, default: 12 } as const

export interface EmergencyFundSettings {
  /** The category that is the emergency fund, or null until one is chosen. */
  categoryId: string | null
  /** Months of Need spending the fund should cover. */
  months: number
  /** How many trailing months of Need spending are averaged. */
  window: number
}

export interface EmergencyFund {
  settings: EmergencyFundSettings
  /** What the chosen category has available at the end of `asOf`; 0 with no category. */
  balance: number
  /** The average month of Need spending, integer cents, over `averagedMonths` months. */
  averageNeed: number
  /** Less than `settings.window` when the spending history is shorter. */
  averagedMonths: number
  /** `settings.months` × `averageNeed`, integer cents. */
  target: number
  /** How far the balance is below the target; 0 once it is met. */
  shortfall: number
  /**
   * The balance divided by the average month of Need spending, rounded down to a tenth so
   * it never overstates. Null when there is no Need spending to measure against.
   */
  monthsCovered: number | null
}

export interface EmergencyFundApi {
  /**
   * The emergency fund's target and how many months it covers. The average Need spending
   * runs through `month` (default `asOf`); the balance is the category's available in `asOf`, so the
   * average can stop at the last complete month while the balance is today's.
   */
  getEmergencyFund(input: { month?: Month; asOf: Month }): Promise<EmergencyFund>
  /** Picks the category and the coverage and averaging settings; returns what is now saved. */
  setEmergencyFund(input: EmergencyFundSettings): Promise<EmergencyFundSettings>
}

function assertRange(value: number, range: { min: number; max: number }, what: string) {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`${what} must be a whole number from ${range.min} to ${range.max}`)
  }
}

/** Pure: the fund's figures from its balance and the average month of Need spending. */
export function emergencyFundFigures(
  settings: EmergencyFundSettings,
  balance: number,
  average: { need: number; months: number },
): EmergencyFund {
  const target = settings.months * average.need
  return {
    settings,
    balance,
    averageNeed: average.need,
    averagedMonths: average.months,
    target,
    shortfall: Math.max(target - balance, 0),
    monthsCovered:
      average.need > 0 ? Math.floor((Math.max(balance, 0) * 10) / average.need) / 10 : null,
  }
}

export function emergencyFundApi({ adapter, changes: log }: CrudDeps): EmergencyFundApi {
  async function readSettings(db: SqlRunner): Promise<EmergencyFundSettings & { id: string }> {
    const [h] = await db.query<{
      id: string
      category_id: string | null
      months: number
      window: number
    }>(
      `SELECT id, emergency_fund_category_id AS category_id, emergency_fund_months AS months,
              emergency_fund_window AS window
       FROM households ORDER BY created_at, id LIMIT 1`,
    )
    if (!h) throw new Error('Set up the household first')
    return { id: h.id, categoryId: h.category_id, months: h.months, window: h.window }
  }

  return {
    async getEmergencyFund({ month, asOf }) {
      assertMonth(asOf)
      const through = month ?? asOf
      assertMonth(through)
      return adapter.transaction(async (tx) => {
        const { id: _id, ...settings } = await readSettings(tx)
        const balance = settings.categoryId
          ? ((await monthBalances(tx, asOf)).find((b) => b.categoryId === settings.categoryId)
              ?.available ?? 0)
          : 0
        const { spent, first } = await loadSpending(tx, through)
        return emergencyFundFigures(
          settings,
          balance,
          averageNeedsWants(spent, through, settings.window, first),
        )
      })
    },

    async setEmergencyFund({ categoryId, months, window }) {
      assertRange(months, COVERAGE_RANGE, 'Months of coverage')
      assertRange(window, WINDOW_RANGE, 'The averaging window')
      return adapter.transaction(async (tx) => {
        const current = await readSettings(tx)
        if (categoryId && categoryId !== current.categoryId) {
          const [category] = await tx.query<{ credit_card_account_id: string | null }>(
            'SELECT credit_card_account_id FROM categories WHERE id = ?',
            [categoryId],
          )
          if (!category) throw new Error('Category not found')
          if (category.credit_card_account_id) {
            throw new Error('A credit card payment category can’t be the emergency fund')
          }
        }
        await log(tx).update('households', current.id, {
          emergency_fund_category_id: categoryId || null,
          emergency_fund_months: months,
          emergency_fund_window: window,
        })
        return { categoryId: categoryId || null, months, window }
      })
    },
  }
}
