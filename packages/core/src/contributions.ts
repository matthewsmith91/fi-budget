import type { CrudDeps } from './crud.ts'

/**
 * The IRS limit on what one person may put into IRAs in a year (Roth and traditional
 * together), in cents, for the first year it applies to. It is a default: the household can
 * set its own for a person and year, for a catch-up contribution or an income phase-out.
 */
const IRA_LIMITS: readonly (readonly [year: number, limit: number])[] = [
  [2023, 650_000],
  [2024, 700_000],
  [2025, 700_000],
  [2026, 750_000],
]

/** The built-in annual IRA limit for a year; years outside the table use the nearest one. */
export function defaultIraLimit(year: number): number {
  let limit = IRA_LIMITS[0]![1]
  for (const [from, amount] of IRA_LIMITS) if (year >= from) limit = amount
  return limit
}

export interface RothAccountContribution {
  accountId: string
  name: string
  /** Cents put in during the year. */
  contributed: number
}

export interface RothMemberContribution {
  memberId: string
  displayName: string
  year: number
  /** The limit in force: the household's own for this person and year, or the default. */
  limit: number
  /** True when `limit` is the built-in default. */
  isDefaultLimit: boolean
  /** Total over all of the person's Roth IRAs. */
  contributed: number
  /** `limit - contributed`, negative when over. */
  remaining: number
  over: boolean
  accounts: RothAccountContribution[]
}

export interface RothContributions {
  year: number
  members: RothMemberContribution[]
  /** Roth IRAs with no owner: their contributions can't count against anyone's limit. */
  unowned: RothAccountContribution[]
}

export interface ContributionsApi {
  /**
   * What each person has put into their Roth IRAs in a calendar year, against their limit.
   * A contribution is money transferred in from an account that isn't an investment account
   * (a move between investment accounts is a rollover or conversion), counted by the
   * transfer's date whether or not it has cleared. Roth 401(k)s have their own limit and
   * are not counted.
   */
  getRothContributions(year: number): Promise<RothContributions>
  /** Sets one person's limit for a year, or goes back to the default with `null`. */
  setContributionLimit(input: {
    memberId: string
    year: number
    limit: number | null
  }): Promise<void>
}

function assertYear(year: number) {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new Error('Enter a year')
}

const limitId = (year: number, memberId: string) => `limit-${year}:${memberId}`

export function contributionsApi({ adapter, now, changes: log }: CrudDeps): ContributionsApi {
  return {
    async getRothContributions(year) {
      assertYear(year)
      const members = await adapter.query<{ id: string; display_name: string }>(
        'SELECT id, display_name FROM members ORDER BY created_at, id',
      )
      const rothIras = await adapter.query<{
        id: string
        name: string
        owner: string | null
        contributed: number
      }>(
        `SELECT a.id, a.name, i.owner_member_id AS owner,
           COALESCE((
             SELECT SUM(t.amount) FROM transactions t
             JOIN transactions p ON p.transfer_pair_id = t.transfer_pair_id AND p.id <> t.id
             JOIN accounts pa ON pa.id = p.account_id
             WHERE t.account_id = a.id AND t.amount > 0 AND pa.type <> 'investment'
               AND substr(t.date, 1, 4) = ?
           ), 0) AS contributed
         FROM accounts a JOIN investment_accounts i ON i.id = a.id
         WHERE i.tax_type = 'roth' AND i.kind = 'ira' ORDER BY a.created_at, a.id`,
        [String(year)],
      )
      const limits = await adapter.query<{ member_id: string; amount: number | null }>(
        'SELECT member_id, amount FROM contribution_limits WHERE year = ?',
        [year],
      )
      const own = new Map(limits.map((l) => [l.member_id, l.amount]))
      const result: RothMemberContribution[] = []
      for (const m of members) {
        const accounts = rothIras
          .filter((a) => a.owner === m.id)
          .map((a) => ({ accountId: a.id, name: a.name, contributed: a.contributed }))
        if (accounts.length === 0) continue
        const override = own.get(m.id) ?? null
        const limit = override ?? defaultIraLimit(year)
        const contributed = accounts.reduce((n, a) => n + a.contributed, 0)
        result.push({
          memberId: m.id,
          displayName: m.display_name,
          year,
          limit,
          isDefaultLimit: override === null,
          contributed,
          remaining: limit - contributed,
          over: contributed > limit,
          accounts,
        })
      }
      return {
        year,
        members: result,
        unowned: rothIras
          .filter((a) => a.owner === null)
          .map((a) => ({ accountId: a.id, name: a.name, contributed: a.contributed })),
      }
    },

    async setContributionLimit({ memberId, year, limit }) {
      assertYear(year)
      if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
        throw new Error('A limit is a whole number of cents, zero or more')
      }
      await adapter.transaction(async (tx) => {
        const [member] = await tx.query('SELECT 1 AS x FROM members WHERE id = ?', [memberId])
        if (!member) throw new Error('Member not found')
        const id = limitId(year, memberId)
        const [row] = await tx.query('SELECT 1 AS x FROM contribution_limits WHERE id = ?', [id])
        // A row is never deleted (a delete is permanent), so going back to the default is a null.
        if (row) await log(tx).update('contribution_limits', id, { amount: limit })
        else if (limit !== null) {
          await log(tx).insert('contribution_limits', {
            id,
            member_id: memberId,
            year,
            amount: limit,
            created_at: now(),
          })
        }
      })
    },
  }
}
