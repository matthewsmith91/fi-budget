import { assertMonth, monthBalances, type Month } from './allocations.ts'
import type { ChangeLog } from './changes.ts'
import type { CrudDeps } from './crud.ts'
import { monthsFrom, shiftMonth } from './retirement.ts'
import type { SqlRunner } from './storage.ts'

interface DrawRow {
  month: string
  fund_category_id: string
  category_id: string
  amount: number
}

const keyOf = (month: string, fund: string, category: string) => `${month}|${fund}|${category}`

/** The household's emergency fund category, or null. */
export async function currentFund(db: SqlRunner): Promise<string | null> {
  const [row] = await db.query<{ id: string | null }>(
    'SELECT emergency_fund_category_id AS id FROM households ORDER BY created_at, id LIMIT 1',
  )
  return row?.id ?? null
}

/**
 * Brings the ledger in line with the transactions marked as emergencies: each categorized line
 * of an approved emergency on a budget account is paid for by moving its amount from the fund
 * into the line's category, in the transaction's month. A refund line moves it back. Spending
 * from a goal and lines already in the fund itself are left out.
 *
 * Like `settleIncome` it compares what is wanted with what the transaction's moves already add
 * up to and appends the difference (the ledger is append-only, so undoing is a negative entry),
 * under ids built from the transaction, fund, month and category so two devices settling the
 * same state write the same rows. A transaction that was unmarked, deleted or is no longer an
 * emergency gives everything back to the fund. Moves from a fund that is no longer the
 * household's (it was deleted) are history and are never touched. Returns how many entries it
 * added.
 */
export async function settleEmergency(
  tx: SqlRunner,
  changes: ChangeLog,
  at: string,
  transactionIds: Iterable<string | null | undefined>,
): Promise<number> {
  const ids = [...new Set([...transactionIds].filter((id): id is string => !!id))]
  if (ids.length === 0) return 0
  // With no fund there is nothing to draw from and nothing to give back to: moves already made
  // against a fund that has since been deleted are history and stay as they are.
  const fund = await currentFund(tx)
  if (!fund) return 0
  let added = 0
  for (const id of ids) {
    const have = await tx.query<DrawRow & Record<string, never>>(
      `SELECT month, fund_category_id, category_id, SUM(amount) AS amount FROM allocations
       WHERE source_transaction_id = ? AND source = 'move' AND fund_category_id = ?
         AND category_id <> fund_category_id
       GROUP BY month, fund_category_id, category_id`,
      [id, fund],
    )
    const [txn] = await tx.query<{
      date: string
      payee: string | null
      emergency: number
      approved: number
      transfer_pair_id: string | null
      on_budget: number
    }>(
      `SELECT t.date, t.payee, t.emergency, t.approved, t.transfer_pair_id, a.on_budget
       FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`,
      [id],
    )
    const standing =
      !!txn &&
      txn.emergency === 1 &&
      txn.approved === 1 &&
      txn.transfer_pair_id === null &&
      txn.on_budget === 1
    if (!standing && have.length === 0) continue

    const slots = new Map<string, DrawRow>()
    if (standing) {
      const month = txn.date.slice(0, 7)
      const lines = await tx.query<{ category_id: string; amount: number }>(
        `SELECT category_id, SUM(amount) AS amount FROM transaction_splits
         WHERE transaction_id = ? AND category_id IS NOT NULL AND category_id <> ?
           AND goal_id IS NULL
         GROUP BY category_id`,
        [id, fund],
      )
      for (const line of lines) {
        if (line.amount === 0) continue
        slots.set(keyOf(month, fund, line.category_id), {
          month,
          fund_category_id: fund,
          category_id: line.category_id,
          amount: -line.amount,
        })
      }
    }
    for (const row of have) {
      const key = keyOf(row.month, row.fund_category_id, row.category_id)
      const slot = slots.get(key) ?? { ...row, amount: 0 }
      slot.amount -= row.amount
      slots.set(key, slot)
    }

    const label = txn?.payee ? `Emergency: ${txn.payee}` : 'Emergency'
    for (const key of [...slots.keys()].sort()) {
      const slot = slots.get(key)!
      if (slot.amount === 0) continue
      const [counted] = await tx.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM allocations
         WHERE source_transaction_id = ? AND source = 'move' AND month = ?
           AND fund_category_id = ? AND category_id = ?`,
        [id, slot.month, slot.fund_category_id, slot.category_id],
      )
      const n = counted?.n ?? 0
      const base = `emergency:${id}:${slot.fund_category_id}:${slot.month}:${slot.category_id}:${n}`
      const note = standing ? label : `${label} (undone)`
      const common = {
        month: slot.month,
        source: 'move',
        note,
        source_transaction_id: id,
        fund_category_id: slot.fund_category_id,
        created_at: at,
      }
      await changes.insert('allocations', {
        id: base,
        category_id: slot.category_id,
        amount: slot.amount,
        ...common,
      })
      await changes.insert('allocations', {
        id: `${base}:fund`,
        category_id: slot.fund_category_id,
        amount: -slot.amount,
        ...common,
      })
      added += 2
    }
  }
  return added
}

/** One emergency transaction, with what it took out of the fund. */
export interface EmergencyDraw {
  transactionId: string
  /** `YYYY-MM-DD` */
  date: string
  payee: string | null
  accountId: string
  /** The transaction's amount, signed like any other (an emergency expense is negative). */
  amount: number
  /** Net cents it moved out of the fund (a refund moves some back); 0 until it has moved. */
  drawn: number
  /** The categories its lines are in, which is where the money went. */
  categoryIds: string[]
  /**
   * The fund's balance at the end of the month it happened in; null once the household has no
   * fund (the draw is still listed, as history).
   */
  balanceAfter: number | null
  /**
   * Whole months after the emergency's month until the fund was back at the level it would have
   * had without the month's emergencies; 0 when it never fell below that, null if it hasn't been
   * yet or there is no fund to measure.
   */
  refilledIn: number | null
}

export interface EmergencyReport {
  year: number
  /** Whether the household has an emergency fund now. */
  hasFund: boolean
  /** Emergencies in the year, newest first. */
  draws: EmergencyDraw[]
  /** Cents drawn from the fund by those emergencies, net. */
  total: number
}

export interface EmergencyDrawsApi {
  /**
   * The year's emergencies: what each took from the emergency fund, the fund's balance when the
   * month ended and how many months it took to refill, measured through `asOf`. Only approved
   * emergencies on budget accounts count.
   */
  getEmergencyReport(input: { year: number; asOf: Month }): Promise<EmergencyReport>
}

/**
 * Pure: how many whole months after `drawMonth` the fund was back at `target` (its level without
 * the emergencies), from its balance at the end of each month. 0 if it never fell below it, null
 * if it hasn't recovered by the last month given or the target isn't positive.
 */
export function refillMonths(
  balances: ReadonlyMap<Month, number>,
  drawMonth: Month,
  target: number,
): number | null {
  if (target <= 0) return null
  if ((balances.get(drawMonth) ?? 0) >= target) return 0
  const later = [...balances.keys()].filter((m) => m > drawMonth).sort()
  for (const month of later) {
    if ((balances.get(month) ?? 0) >= target) return monthsFrom(drawMonth, month)
  }
  return null
}

export function emergencyDrawsApi({ adapter }: CrudDeps): EmergencyDrawsApi {
  return {
    async getEmergencyReport({ year, asOf }) {
      assertMonth(asOf)
      if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new Error('Enter a year')
      return adapter.transaction(async (tx) => {
        const fund = await currentFund(tx)
        const rows = await tx.query<{
          id: string
          date: string
          payee: string | null
          account_id: string
          amount: number
          drawn: number
        }>(
          `SELECT t.id, t.date, t.payee, t.account_id, t.amount,
             (SELECT COALESCE(SUM(al.amount), 0) FROM allocations al
               WHERE al.source_transaction_id = t.id AND al.source = 'move'
                 AND al.fund_category_id IS NOT NULL AND al.category_id <> al.fund_category_id
             ) AS drawn
           FROM transactions t JOIN accounts a ON a.id = t.account_id
           WHERE t.emergency = 1 AND t.approved = 1 AND t.transfer_pair_id IS NULL
             AND a.on_budget = 1 AND substr(t.date, 1, 4) = ?
           ORDER BY t.date DESC, t.created_at DESC, t.id DESC`,
          [String(year)],
        )
        const categories = new Map<string, string[]>()
        for (const c of await tx.query<{ transaction_id: string; category_id: string }>(
          `SELECT DISTINCT s.transaction_id, s.category_id FROM transaction_splits s
           JOIN transactions t ON t.id = s.transaction_id
           WHERE t.emergency = 1 AND substr(t.date, 1, 4) = ? AND s.category_id IS NOT NULL
           ORDER BY s.category_id`,
          [String(year)],
        )) {
          categories.set(c.transaction_id, [
            ...(categories.get(c.transaction_id) ?? []),
            c.category_id,
          ])
        }

        // The fund's balance at the end of each month from January through `asOf`.
        const balances = new Map<Month, number>()
        const first = `${year}-01`
        if (fund && rows.length > 0) {
          for (let m = first; m <= asOf; m = shiftMonth(m, 1)) {
            const row = (await monthBalances(tx, m)).find((b) => b.categoryId === fund)
            balances.set(m, row?.available ?? 0)
          }
        }
        const drawnIn = new Map<Month, number>()
        for (const r of rows) {
          const month = r.date.slice(0, 7)
          drawnIn.set(month, (drawnIn.get(month) ?? 0) + r.drawn)
        }

        const draws = rows.map((r): EmergencyDraw => {
          const month = r.date.slice(0, 7)
          const after = fund ? (balances.get(month) ?? null) : null
          return {
            transactionId: r.id,
            date: r.date,
            payee: r.payee,
            accountId: r.account_id,
            amount: r.amount,
            drawn: r.drawn,
            categoryIds: categories.get(r.id) ?? [],
            balanceAfter: after,
            refilledIn:
              after === null
                ? null
                : refillMonths(balances, month, after + (drawnIn.get(month) ?? 0)),
          }
        })
        return {
          year,
          hasFund: fund !== null,
          draws,
          total: draws.reduce((sum, d) => sum + d.drawn, 0),
        }
      })
    },
  }
}
