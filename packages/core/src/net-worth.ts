import { assertMonth, type Month } from './allocations.ts'
import type { CrudDeps } from './crud.ts'
import type { AccountType } from './accounts.ts'
import type { SqlRunner } from './storage.ts'

/** Where everything stood at the end of one month, in integer cents. */
export interface NetWorthMonth {
  month: Month
  /** Assets minus liabilities. */
  netWorth: number
  /** The accounts with a positive value, added up. */
  assets: number
  /** The accounts with a negative value (a card balance, an overdraft), added up; zero or less. */
  liabilities: number
}

export interface NetWorthAccount {
  accountId: string
  name: string
  type: AccountType
  closed: boolean
  /** Its value at the end of the report's last month. */
  value: number
}

export interface NetWorthReport {
  /** Oldest first, ending with the report's month. */
  months: NetWorthMonth[]
  /** Accounts that are worth something (or owe something) at the end of the last month. */
  accounts: NetWorthAccount[]
}

export interface NetWorthApi {
  /**
   * Net worth at the end of each of `months` months (default 12) ending with `month`, across
   * every account, budget and tracking, closed ones included. A bank or credit account is
   * worth what its transactions add up to. An investment account is worth its newest
   * valuation dated on or before the month's end; before its first valuation it is worth what
   * has been put into it, so money moved in from checking doesn't read as lost.
   */
  getNetWorthReport(input: { month: Month; months?: number }): Promise<NetWorthReport>
}

function shift(month: Month, by: number): Month {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

export interface AccountHistory {
  accountId: string
  name: string
  type: AccountType
  closed: boolean
  /** Net transaction amount per month, any order. */
  flows: ReadonlyMap<Month, number>
  /** Investment accounts only: `[date, market value]`, any order. */
  valuations: readonly (readonly [date: string, value: number])[]
}

/** Pure: an account's value at the end of `month`. */
export function valueAtMonthEnd(account: AccountHistory, month: Month): number {
  if (account.type === 'investment') {
    let newest: readonly [string, number] | undefined
    for (const v of account.valuations) {
      if (v[0].slice(0, 7) <= month && (!newest || v[0] > newest[0])) newest = v
    }
    if (newest) return newest[1]
  }
  let sum = 0
  for (const [m, amount] of account.flows) if (m <= month) sum += amount
  return sum
}

/** Pure: the series for the `count` months ending at `month`. */
export function netWorthReport(
  accounts: readonly AccountHistory[],
  month: Month,
  count: number,
): NetWorthReport {
  const months: NetWorthMonth[] = []
  for (let i = count - 1; i >= 0; i--) {
    const m = shift(month, -i)
    let assets = 0
    let liabilities = 0
    for (const a of accounts) {
      const v = valueAtMonthEnd(a, m)
      if (v > 0) assets += v
      else liabilities += v
    }
    months.push({ month: m, netWorth: assets + liabilities, assets, liabilities })
  }
  return {
    months,
    accounts: accounts
      .map((a) => ({
        accountId: a.accountId,
        name: a.name,
        type: a.type,
        closed: a.closed,
        value: valueAtMonthEnd(a, month),
      }))
      .filter((a) => a.value !== 0),
  }
}

/** Every account with its monthly flows and valuations through `month`, oldest account first. */
export async function loadAccountHistories(db: SqlRunner, month: Month): Promise<AccountHistory[]> {
  const accounts = await db.query<{ id: string; name: string; type: AccountType; closed: number }>(
    'SELECT id, name, type, closed FROM accounts ORDER BY created_at, id',
  )
  const flows = await db.query<{ account_id: string; month: string; amount: number }>(
    `SELECT account_id, substr(date, 1, 7) AS month, SUM(amount) AS amount
     FROM transactions WHERE substr(date, 1, 7) <= ? GROUP BY account_id, month`,
    [month],
  )
  const valuations = await db.query<{ account_id: string; date: string; market_value: number }>(
    'SELECT account_id, date, market_value FROM account_valuations WHERE substr(date, 1, 7) <= ?',
    [month],
  )
  return accounts.map((a) => ({
    accountId: a.id,
    name: a.name,
    type: a.type,
    closed: a.closed === 1,
    flows: new Map(flows.filter((f) => f.account_id === a.id).map((f) => [f.month, f.amount])),
    valuations: valuations
      .filter((v) => v.account_id === a.id)
      .map((v) => [v.date, v.market_value]),
  }))
}

export function netWorthApi({ adapter }: CrudDeps): NetWorthApi {
  return {
    async getNetWorthReport({ month, months = 12 }) {
      assertMonth(month)
      if (!Number.isInteger(months) || months < 1 || months > 120) {
        throw new Error('Pick between 1 and 120 months')
      }
      return netWorthReport(await loadAccountHistories(adapter, month), month, months)
    },
  }
}
