import { assertMonth, monthBalances, type Month } from './allocations.ts'
import {
  ensureEmergencyFundCategory,
  removeCategoryIn,
  tidyReservesGroup,
  type CategoryRemoval,
} from './categories.ts'
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
  /** Just the saved settings: whether there is a fund, without working out its figures. */
  getEmergencyFundSettings(): Promise<EmergencyFundSettings>
  /** Picks the category and the coverage and averaging settings; returns what is now saved. */
  setEmergencyFund(input: EmergencyFundSettings): Promise<EmergencyFundSettings>
  /**
   * Starts the emergency fund: a new "Emergency Fund" category in the Reserves group, or
   * `categoryId` if the household already has one. Refused while there is a fund. Coverage and
   * averaging keep their saved values unless given.
   */
  createEmergencyFund(input?: {
    categoryId?: string
    months?: number
    window?: number
  }): Promise<EmergencyFundSettings>
  /**
   * Ends the emergency fund by taking its category out of the budget (see `removeCategory`: its
   * money goes back to Ready to Assign in `month`). The coverage and averaging settings stay for
   * next time. Refused while the fund is overspent.
   */
  deleteEmergencyFund(input: { month: Month }): Promise<CategoryRemoval>
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

export function emergencyFundApi(deps: CrudDeps): EmergencyFundApi {
  const { adapter, changes: log } = deps
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

  async function assertUsable(db: SqlRunner, categoryId: string) {
    const [category] = await db.query<{ credit_card_account_id: string | null }>(
      'SELECT credit_card_account_id FROM categories WHERE id = ?',
      [categoryId],
    )
    if (!category) throw new Error('Category not found')
    if (category.credit_card_account_id) {
      throw new Error('A credit card payment category can’t be the emergency fund')
    }
  }

  return {
    async getEmergencyFundSettings() {
      return adapter.transaction(async (tx) => {
        const { id: _id, ...settings } = await readSettings(tx)
        return settings
      })
    },

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
        if (categoryId && categoryId !== current.categoryId) await assertUsable(tx, categoryId)
        await log(tx).update('households', current.id, {
          emergency_fund_category_id: categoryId || null,
          emergency_fund_months: months,
          emergency_fund_window: window,
        })
        return { categoryId: categoryId || null, months, window }
      })
    },

    async createEmergencyFund({ categoryId, months, window } = {}) {
      return adapter.transaction(async (tx) => {
        const current = await readSettings(tx)
        if (current.categoryId) throw new Error('There is already an emergency fund')
        const nextMonths = months ?? current.months
        const nextWindow = window ?? current.window
        assertRange(nextMonths, COVERAGE_RANGE, 'Months of coverage')
        assertRange(nextWindow, WINDOW_RANGE, 'The averaging window')
        const changes = log(tx)
        let chosen = categoryId
        if (chosen) await assertUsable(tx, chosen)
        else chosen = await ensureEmergencyFundCategory(tx, changes, deps.now())
        await changes.update('households', current.id, {
          emergency_fund_category_id: chosen,
          emergency_fund_months: nextMonths,
          emergency_fund_window: nextWindow,
        })
        return { categoryId: chosen, months: nextMonths, window: nextWindow }
      })
    },

    async deleteEmergencyFund({ month }) {
      assertMonth(month)
      return adapter.transaction(async (tx) => {
        const { categoryId } = await readSettings(tx)
        if (!categoryId) throw new Error('There is no emergency fund')
        const removal = await removeCategoryIn(tx, deps, categoryId, month)
        await tidyReservesGroup(tx, log(tx))
        return removal
      })
    },
  }
}
