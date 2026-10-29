import { assertMonth, monthBalances, readyToAssign, type Month } from './allocations.ts'
import type { NeedOrWant } from './categories.ts'
import type { CrudDeps } from './crud.ts'
import { emergencyFundApi, type EmergencyFund } from './emergency-fund.ts'
import { goalsApi, type AccountHolding } from './goals.ts'

/** A category that spent more than it had this month. */
export interface ReviewOverspent {
  categoryId: string
  name: string
  /** How far below zero it ended, as a positive amount. */
  amount: number
}

/** A goal that has not had its share of the monthly amount it needs. */
export interface ReviewUnderfunded {
  goalId: string
  categoryId: string
  name: string
  categoryName: string
  /** What it needs each month to reach its target on time. */
  monthlyNeeded: number
  /** Still unassigned out of `monthlyNeeded` this month. */
  shortBy: number
  percentFunded: number
}

/** One move the review proposes. Applying it is `allocate` or `moveAllocation` for `month`. */
export interface ReviewSuggestion {
  reason: 'overspent' | 'underfunded'
  /** Where the money comes from; null is Ready to Assign. */
  fromCategoryId: string | null
  fromName: string
  toCategoryId: string
  /** The goal that receives it, or null for the category itself. */
  toGoalId: string | null
  toName: string
  /** Positive cents. */
  amount: number
}

export interface MonthlyReview {
  month: Month
  readyToAssign: number
  /** Assigned to categories this month, net. */
  assigned: number
  /** Spent this month from categories, net of refunds; positive. */
  spent: number
  overspent: ReviewOverspent[]
  underfunded: ReviewUnderfunded[]
  /** Accounts whose goals hold more than the account does. */
  overAllocated: (AccountHolding & { name: string })[]
  /** Null when no emergency fund category is chosen. */
  emergencyFund: EmergencyFund | null
  suggestions: ReviewSuggestion[]
  /** Overspending the suggestions don't cover. */
  uncovered: number
}

export interface MonthlyReviewApi {
  /**
   * What went over, what is underfunded and what to move, as of the end of `month`. Overspent
   * categories are covered first from Ready to Assign, then from the unassigned money in
   * other categories (wants before needs, the largest first); underfunded goals take what
   * Ready to Assign has left. Never takes from the emergency fund, a card's payment category,
   * a hidden category or money that belongs to a goal.
   */
  getMonthlyReview(input: { month: Month }): Promise<MonthlyReview>
}

interface Donor {
  categoryId: string
  name: string
  spare: number
  tag: NeedOrWant
}

type Need = { categoryId: string; goalId: string | null; name: string; amount: number }

/** Pure: the moves that cover `overspent` and `underfunded` from `ready` and then `donors`. */
export function suggestMoves(input: {
  ready: number
  overspent: readonly ReviewOverspent[]
  underfunded: readonly ReviewUnderfunded[]
  donors: readonly Donor[]
}): { suggestions: ReviewSuggestion[]; uncovered: number } {
  let pool = Math.max(input.ready, 0)
  const donors = input.donors
    .filter((d) => d.spare > 0)
    .map((d) => ({ ...d }))
    .sort(
      (a, b) =>
        (a.tag === b.tag ? 0 : a.tag === 'want' ? -1 : 1) ||
        b.spare - a.spare ||
        (a.categoryId < b.categoryId ? -1 : 1),
    )
  const suggestions: ReviewSuggestion[] = []
  let uncovered = 0

  const needs: Need[] = [...input.overspent]
    .sort((a, b) => b.amount - a.amount || (a.categoryId < b.categoryId ? -1 : 1))
    .map((o) => ({ categoryId: o.categoryId, goalId: null, name: o.name, amount: o.amount }))
  for (const need of needs) {
    let left = need.amount
    const fromReady = Math.min(pool, left)
    if (fromReady > 0) {
      suggestions.push({
        reason: 'overspent',
        fromCategoryId: null,
        fromName: 'Ready to Assign',
        toCategoryId: need.categoryId,
        toGoalId: null,
        toName: need.name,
        amount: fromReady,
      })
      pool -= fromReady
      left -= fromReady
    }
    for (const donor of donors) {
      if (left === 0) break
      const take = Math.min(donor.spare, left)
      if (take === 0) continue
      suggestions.push({
        reason: 'overspent',
        fromCategoryId: donor.categoryId,
        fromName: donor.name,
        toCategoryId: need.categoryId,
        toGoalId: null,
        toName: need.name,
        amount: take,
      })
      donor.spare -= take
      left -= take
    }
    uncovered += left
  }

  const goals = [...input.underfunded].sort(
    (a, b) => b.shortBy - a.shortBy || (a.goalId < b.goalId ? -1 : 1),
  )
  for (const goal of goals) {
    const take = Math.min(pool, goal.shortBy)
    if (take === 0) continue
    suggestions.push({
      reason: 'underfunded',
      fromCategoryId: null,
      fromName: 'Ready to Assign',
      toCategoryId: goal.categoryId,
      toGoalId: goal.goalId,
      toName: `${goal.categoryName}: ${goal.name}`,
      amount: take,
    })
    pool -= take
  }
  return { suggestions, uncovered }
}

export function monthlyReviewApi(deps: CrudDeps): MonthlyReviewApi {
  const { adapter } = deps
  const goals = goalsApi(deps)
  const fund = emergencyFundApi(deps)

  return {
    async getMonthlyReview({ month }) {
      assertMonth(month)
      const { balances, categories, ready, goalRows, accountNames } = await adapter.transaction(
        async (tx) => ({
          balances: await monthBalances(tx, month),
          ready: await readyToAssign(tx, month),
          categories: await tx.query<{
            id: string
            name: string
            need_or_want: NeedOrWant
            hidden: number
            card: string | null
            fund: number
          }>(
            `SELECT c.id AS id, c.name AS name, c.need_or_want AS need_or_want, c.hidden AS hidden,
                    c.credit_card_account_id AS card,
                    CASE WHEN EXISTS (SELECT 1 FROM households h
                                      WHERE h.emergency_fund_category_id = c.id) THEN 1 ELSE 0 END AS fund
             FROM categories c`,
          ),
          goalRows: await tx.query<{ id: string; name: string; archived: number }>(
            'SELECT id, name, archived FROM goals',
          ),
          accountNames: await tx.query<{ id: string; name: string }>(
            'SELECT id, name FROM accounts',
          ),
        }),
      )
      const goalBalances = await goals.getGoalBalances(month)
      const holdings = await goals.getAccountHoldings(month)
      const fundSettings = await fund.getEmergencyFund({ asOf: month })

      const category = new Map(categories.map((c) => [c.id, c]))
      const isSpending = (id: string) => category.get(id)?.card === null

      const overspent: ReviewOverspent[] = balances
        .filter((b) => isSpending(b.categoryId) && b.available < 0)
        .map((b) => ({
          categoryId: b.categoryId,
          name: category.get(b.categoryId)!.name,
          amount: -b.available,
        }))

      const goalInfo = new Map(goalRows.map((g) => [g.id, g]))
      const underfunded: ReviewUnderfunded[] = goalBalances
        .filter((g) => g.underfunded > 0 && goalInfo.get(g.goalId)?.archived === 0)
        .map((g) => ({
          goalId: g.goalId,
          categoryId: g.categoryId,
          name: goalInfo.get(g.goalId)!.name,
          categoryName: category.get(g.categoryId)?.name ?? '',
          monthlyNeeded: g.monthlyNeeded ?? 0,
          shortBy: g.underfunded,
          percentFunded: g.percentFunded,
        }))

      // What a category can give up is what is left once its goals' money is set aside.
      const inGoals = new Map<string, number>()
      for (const g of goalBalances) {
        inGoals.set(g.categoryId, (inGoals.get(g.categoryId) ?? 0) + g.available)
      }
      const donors: Donor[] = balances
        .filter((b) => {
          const c = category.get(b.categoryId)
          return c && c.card === null && c.hidden === 0 && c.fund === 0 && b.available > 0
        })
        .map((b) => ({
          categoryId: b.categoryId,
          name: category.get(b.categoryId)!.name,
          spare: Math.max(b.available - (inGoals.get(b.categoryId) ?? 0), 0),
          tag: category.get(b.categoryId)!.need_or_want,
        }))

      const { suggestions, uncovered } = suggestMoves({ ready, overspent, underfunded, donors })

      let assigned = 0
      let spent = 0
      for (const b of balances) {
        if (!isSpending(b.categoryId)) continue
        assigned += b.assigned
        spent -= b.activity
      }
      const names = new Map(accountNames.map((a) => [a.id, a.name]))
      return {
        month,
        readyToAssign: ready,
        assigned,
        spent,
        overspent,
        underfunded,
        overAllocated: holdings
          .filter((h) => h.over > 0)
          .map((h) => ({ ...h, name: names.get(h.accountId) ?? '' })),
        emergencyFund: fundSettings.settings.categoryId ? fundSettings : null,
        suggestions,
        uncovered,
      }
    },
  }
}
