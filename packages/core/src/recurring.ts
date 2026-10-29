import { assertMonth, type Month } from './allocations.ts'
import type { ChangeLog } from './changes.ts'
import type { NeedOrWant } from './categories.ts'
import { assertDate, cleanName, type CrudDeps } from './crud.ts'
import type { SqlRunner } from './storage.ts'

export const RECURRING_CADENCES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] as const
export type RecurringCadence = (typeof RECURRING_CADENCES)[number]

export const FORECAST_DAYS = { min: 7, max: 90, default: 60 } as const

/** A bill or paycheck that comes round on a schedule. */
export interface RecurringItem {
  id: string
  payee: string
  /** Integer cents; a bill is negative, a paycheck positive. */
  amount: number
  cadence: RecurringCadence
  /** `YYYY-MM-DD`: the next occurrence nobody has dealt with yet. Earlier than today is overdue. */
  nextDate: string
  /** Its tag in the budget comes from this category. */
  categoryId: string | null
  /** The account it goes through; an item on a tracking account stays out of the forecast. */
  accountId: string | null
}

export interface RecurringInput {
  payee: string
  amount: number
  cadence: RecurringCadence
  nextDate: string
  categoryId?: string | null
  accountId?: string | null
}

export interface BillOccurrence {
  recurringId: string
  payee: string
  amount: number
  /** The scheduled date; before today means it is past due. */
  date: string
  categoryId: string | null
  /** The category's tag, null without a category. */
  needOrWant: NeedOrWant | null
}

export interface BillsCalendar {
  month: Month
  /** Days that have something due, oldest first. */
  days: { date: string; items: BillOccurrence[] }[]
  /** Bills due in the month, as a positive total. */
  due: number
  /** Money expected in the month. */
  expected: number
}

export interface ForecastEvent {
  recurringId: string
  payee: string
  amount: number
  /** Past due; counted on the first day of the forecast. */
  overdue: boolean
}

export interface ForecastDay {
  date: string
  /** Cash at the end of the day. */
  balance: number
  events: ForecastEvent[]
}

export interface CashFlowForecast {
  from: string
  days: ForecastDay[]
  /** Cash in the budget's checking and savings accounts through `from`. */
  startBalance: number
  endBalance: number
  /** The lowest end-of-day balance in the window, and when. */
  lowest: { date: string; balance: number }
  /** The first day the balance goes below zero, or null if it never does. */
  firstNegative: string | null
  /** Money expected in the window. */
  inflow: number
  /** Bills due in the window, as a positive total. */
  outflow: number
  accounts: { accountId: string; name: string; balance: number }[]
}

export interface RecurringApi {
  listRecurring(): Promise<RecurringItem[]>
  createRecurring(input: RecurringInput): Promise<RecurringItem>
  /** Changing `nextDate` also resets the day of the month a monthly item keeps to. */
  updateRecurring(id: string, changes: Partial<RecurringInput>): Promise<RecurringItem>
  deleteRecurring(id: string): Promise<void>
  /** Moves an item to its next occurrence: after it was paid, or to skip one. */
  advanceRecurring(id: string): Promise<RecurringItem>
  /**
   * What falls due in `month`, from each item's next date on; nothing before it, since an
   * earlier occurrence is taken to have been dealt with.
   */
  getBillsCalendar(input: { month: Month }): Promise<BillsCalendar>
  /**
   * Cash day by day for `days` days (7-90, default 60) starting `from`: the balance of the
   * budget's checking and savings accounts through `from`, less the bills and plus the
   * paychecks that fall due. A bill that is past due counts once, on the first day. An item
   * stays due until it is advanced, so advance it once its transaction is entered or the
   * bill is counted twice. A bill charged to a credit card counts on the day it is charged,
   * as if paid at once.
   */
  getCashFlowForecast(input: { from: string; days?: number }): Promise<CashFlowForecast>
}

interface RecurringRow {
  id: string
  payee: string
  amount: number
  cadence: RecurringCadence
  next_date: string
  anchor_day: number
  category_id: string | null
  account_id: string | null
}

const toItem = (r: RecurringRow): RecurringItem => ({
  id: r.id,
  payee: r.payee,
  amount: r.amount,
  cadence: r.cadence,
  nextDate: r.next_date,
  categoryId: r.category_id,
  accountId: r.account_id,
})

const SELECT =
  'SELECT id, payee, amount, cadence, next_date, anchor_day, category_id, account_id FROM recurring'

const DAY_MS = 86_400_000
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`)

/** Pure: `date` moved by whole days. */
export const addDays = (date: string, days: number): string =>
  new Date(utc(date) + days * DAY_MS).toISOString().slice(0, 10)

/** Pure: whole days from `from` to `to`; negative when `to` is earlier. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((utc(to) - utc(from)) / DAY_MS)

function addMonthsAnchored(date: string, months: number, anchorDay: number): string {
  const index = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const day = Math.min(anchorDay, lastDay)
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Pure: the occurrence after `date`. A monthly bill keeps to `anchorDay`, so one on the 31st
 * lands on the 28th in February and goes back to the 31st after it.
 */
export function stepRecurring(date: string, cadence: RecurringCadence, anchorDay: number): string {
  switch (cadence) {
    case 'weekly':
      return addDays(date, 7)
    case 'biweekly':
      return addDays(date, 14)
    case 'monthly':
      return addMonthsAnchored(date, 1, anchorDay)
    case 'quarterly':
      return addMonthsAnchored(date, 3, anchorDay)
    case 'yearly':
      return addMonthsAnchored(date, 12, anchorDay)
  }
}

/**
 * Pure: when an item falls due from `from` through `to`, both included. If its next date
 * is already behind `from` that one occurrence comes first, marked overdue, at its own date;
 * the schedule then carries on from the first date on or after `from`, so an item that was
 * missed for months doesn't pile up charges.
 */
export function recurringOccurrences(
  item: Pick<RecurringRow, 'next_date' | 'cadence' | 'anchor_day'>,
  from: string,
  to: string,
): { date: string; overdue: boolean }[] {
  const out: { date: string; overdue: boolean }[] = []
  let date = item.next_date
  if (date < from) {
    out.push({ date, overdue: true })
    while (date < from) date = stepRecurring(date, item.cadence, item.anchor_day)
  }
  while (date <= to) {
    out.push({ date, overdue: false })
    date = stepRecurring(date, item.cadence, item.anchor_day)
  }
  return out
}

/** Removes the account's recurring items' link to it, and the category's, when either goes. */
export async function clearRecurringLinks(
  db: SqlRunner,
  changes: ChangeLog,
  link: { accountId: string } | { categoryId: string },
) {
  const rows =
    'accountId' in link
      ? await db.query<{ id: string }>('SELECT id FROM recurring WHERE account_id = ?', [
          link.accountId,
        ])
      : await db.query<{ id: string }>('SELECT id FROM recurring WHERE category_id = ?', [
          link.categoryId,
        ])
  for (const { id } of rows) {
    await changes.update(
      'recurring',
      id,
      'accountId' in link ? { account_id: null } : { category_id: null },
    )
  }
}

export function recurringApi({ adapter, newId, now, changes: log }: CrudDeps): RecurringApi {
  async function getRow(db: SqlRunner, id: string): Promise<RecurringRow> {
    const [row] = await db.query<RecurringRow & Record<string, never>>(`${SELECT} WHERE id = ?`, [
      id,
    ])
    if (!row) throw new Error('Recurring item not found')
    return row
  }

  async function assertLinks(db: SqlRunner, categoryId: string | null, accountId: string | null) {
    if (categoryId !== null) {
      const [category] = await db.query<{ credit_card_account_id: string | null }>(
        'SELECT credit_card_account_id FROM categories WHERE id = ?',
        [categoryId],
      )
      if (!category) throw new Error('Category not found')
      if (category.credit_card_account_id) {
        throw new Error('A credit card payment category can’t be used on a transaction')
      }
    }
    if (accountId !== null) {
      const [account] = await db.query<{ closed: number }>(
        'SELECT closed FROM accounts WHERE id = ?',
        [accountId],
      )
      if (!account) throw new Error('Account not found')
      if (account.closed === 1) throw new Error('That account is closed')
    }
  }

  function assertItem(item: { amount: number; cadence: string; nextDate: string }) {
    if (!Number.isSafeInteger(item.amount) || item.amount === 0) {
      throw new Error('The amount must be a whole number of cents, not zero')
    }
    if (!RECURRING_CADENCES.includes(item.cadence as RecurringCadence)) {
      throw new Error(`Unknown cadence "${item.cadence}"`)
    }
    assertDate(item.nextDate)
  }

  /** The day of the month a new next date asks the item to keep to. */
  const anchorOf = (date: string) => Number(date.slice(8, 10))

  return {
    async listRecurring() {
      const rows = await adapter.query<RecurringRow & Record<string, never>>(
        `${SELECT} ORDER BY next_date, created_at, id`,
      )
      return rows.map(toItem)
    },

    async createRecurring(input) {
      const item = {
        payee: cleanName(input.payee, 'Payee'),
        amount: input.amount,
        cadence: input.cadence,
        nextDate: input.nextDate,
        categoryId: input.categoryId ?? null,
        accountId: input.accountId ?? null,
      }
      assertItem(item)
      return adapter.transaction(async (tx) => {
        await assertLinks(tx, item.categoryId, item.accountId)
        const id = newId()
        await log(tx).insert('recurring', {
          id,
          payee: item.payee,
          amount: item.amount,
          cadence: item.cadence,
          next_date: item.nextDate,
          anchor_day: anchorOf(item.nextDate),
          category_id: item.categoryId,
          account_id: item.accountId,
          created_at: now(),
        })
        return toItem(await getRow(tx, id))
      })
    },

    async updateRecurring(id, changes) {
      return adapter.transaction(async (tx) => {
        const current = toItem(await getRow(tx, id))
        const next = {
          payee: changes.payee === undefined ? current.payee : cleanName(changes.payee, 'Payee'),
          amount: changes.amount ?? current.amount,
          cadence: changes.cadence ?? current.cadence,
          nextDate: changes.nextDate ?? current.nextDate,
          categoryId: changes.categoryId === undefined ? current.categoryId : changes.categoryId,
          accountId: changes.accountId === undefined ? current.accountId : changes.accountId,
        }
        assertItem(next)
        if (next.categoryId !== current.categoryId || next.accountId !== current.accountId) {
          await assertLinks(tx, next.categoryId, next.accountId)
        }
        await log(tx).update('recurring', id, {
          payee: next.payee,
          amount: next.amount,
          cadence: next.cadence,
          next_date: next.nextDate,
          ...(next.nextDate !== current.nextDate ? { anchor_day: anchorOf(next.nextDate) } : {}),
          category_id: next.categoryId,
          account_id: next.accountId,
        })
        return toItem(await getRow(tx, id))
      })
    },

    async deleteRecurring(id) {
      await adapter.transaction(async (tx) => {
        await getRow(tx, id)
        await log(tx).delete('recurring', id)
      })
    },

    async advanceRecurring(id) {
      return adapter.transaction(async (tx) => {
        const row = await getRow(tx, id)
        await log(tx).update('recurring', id, {
          next_date: stepRecurring(row.next_date, row.cadence, row.anchor_day),
        })
        return toItem(await getRow(tx, id))
      })
    },

    async getBillsCalendar({ month }) {
      assertMonth(month)
      const first = `${month}-01`
      const last = addDays(addMonthsAnchored(first, 1, 1), -1)
      const rows = await adapter.query<
        RecurringRow & { need_or_want: NeedOrWant | null } & Record<string, never>
      >(
        `SELECT r.id, r.payee, r.amount, r.cadence, r.next_date, r.anchor_day, r.category_id,
                r.account_id, c.need_or_want
         FROM recurring r LEFT JOIN categories c ON c.id = r.category_id
         ORDER BY r.created_at, r.id`,
      )
      const byDay = new Map<string, BillOccurrence[]>()
      let due = 0
      let expected = 0
      for (const row of rows) {
        for (const o of recurringOccurrences(row, first, last)) {
          if (o.date < first) continue
          const list = byDay.get(o.date) ?? []
          byDay.set(o.date, list)
          list.push({
            recurringId: row.id,
            payee: row.payee,
            amount: row.amount,
            date: o.date,
            categoryId: row.category_id,
            needOrWant: row.need_or_want,
          })
          if (row.amount < 0) due -= row.amount
          else expected += row.amount
        }
      }
      return {
        month,
        days: [...byDay.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([date, items]) => ({ date, items })),
        due,
        expected,
      }
    },

    async getCashFlowForecast({ from, days = FORECAST_DAYS.default }) {
      assertDate(from)
      if (!Number.isInteger(days) || days < FORECAST_DAYS.min || days > FORECAST_DAYS.max) {
        throw new Error(`Forecast between ${FORECAST_DAYS.min} and ${FORECAST_DAYS.max} days`)
      }
      const to = addDays(from, days - 1)
      return adapter.transaction(async (tx) => {
        const accounts = await tx.query<{ id: string; name: string; balance: number }>(
          `SELECT a.id AS id, a.name AS name, COALESCE(SUM(t.amount), 0) AS balance
           FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id AND t.date <= ?
           WHERE a.on_budget = 1 AND a.closed = 0 AND a.type IN ('checking', 'savings')
           GROUP BY a.id ORDER BY a.created_at, a.id`,
          [from],
        )
        const items = await tx.query<
          RecurringRow & { on_budget: number | null } & Record<string, never>
        >(
          `SELECT r.id, r.payee, r.amount, r.cadence, r.next_date, r.anchor_day, r.category_id,
                  r.account_id, a.on_budget
           FROM recurring r LEFT JOIN accounts a ON a.id = r.account_id
           ORDER BY r.created_at, r.id`,
        )
        const startBalance = accounts.reduce((n, a) => n + a.balance, 0)

        const events = new Map<string, ForecastEvent[]>()
        let inflow = 0
        let outflow = 0
        for (const item of items) {
          // an item on a tracking account never touches the budget's cash
          if (item.account_id !== null && item.on_budget !== 1) continue
          for (const o of recurringOccurrences(item, from, to)) {
            const date = o.date < from ? from : o.date
            const list = events.get(date) ?? []
            events.set(date, list)
            list.push({
              recurringId: item.id,
              payee: item.payee,
              amount: item.amount,
              overdue: o.overdue,
            })
            if (item.amount < 0) outflow -= item.amount
            else inflow += item.amount
          }
        }

        let balance = startBalance
        let lowest = { date: from, balance: startBalance }
        let firstNegative: string | null = startBalance < 0 ? from : null
        const out: ForecastDay[] = []
        for (let i = 0; i < days; i++) {
          const date = addDays(from, i)
          const todays = events.get(date) ?? []
          balance += todays.reduce((n, e) => n + e.amount, 0)
          out.push({ date, balance, events: todays })
          if (balance < lowest.balance) lowest = { date, balance }
          if (balance < 0 && firstNegative === null) firstNegative = date
        }
        return {
          from,
          days: out,
          startBalance,
          endBalance: balance,
          lowest,
          firstNegative,
          inflow,
          outflow,
          accounts: accounts.map((a) => ({ accountId: a.id, name: a.name, balance: a.balance })),
        }
      })
    },
  }
}
