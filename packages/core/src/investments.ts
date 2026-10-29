import type { ChangeLog } from './changes.ts'
import { assertDate, type CrudDeps } from './crud.ts'
import type { SqlRunner } from './storage.ts'
import { dropUnitData } from './unit-ledger.ts'

export const TAX_TYPES = ['roth', 'traditional', 'taxable', '529'] as const
export type TaxType = (typeof TAX_TYPES)[number]

/** What sort of account it is, the way Empower asks: a retirement plan, a brokerage, a 529. */
export const INVESTMENT_KINDS = [
  'brokerage',
  'ira',
  '401k',
  '403b',
  '457',
  '401a',
  'sep-ira',
  'simple-ira',
  '529',
  'other',
] as const
export type InvestmentKind = (typeof INVESTMENT_KINDS)[number]

/**
 * The tax types that make sense for a kind, the usual one first: a brokerage is taxable, a
 * 529 is a 529, a retirement plan is traditional or Roth. `other` says nothing, so it allows all.
 */
export function taxTypesFor(kind: InvestmentKind): readonly TaxType[] {
  if (kind === 'brokerage') return ['taxable']
  if (kind === '529') return ['529']
  if (kind === 'other') return ['taxable', 'traditional', 'roth', '529']
  return ['traditional', 'roth']
}

/** `preferred` when the kind allows it, otherwise the kind's usual tax type. */
export const taxTypeFor = (kind: InvestmentKind, preferred?: TaxType): TaxType =>
  preferred && taxTypesFor(kind).includes(preferred) ? preferred : taxTypesFor(kind)[0]!

/**
 * `units`: goals own shares of the whole account and share its return (the default).
 * `holdings`: goals hold different investments inside the account.
 */
export const INVESTMENT_MODES = ['units', 'holdings'] as const
export type InvestmentMode = (typeof INVESTMENT_MODES)[number]

export interface InvestmentSettings {
  kind: InvestmentKind
  taxType: TaxType
  /** Whose account it is (for per-person limits); null for a joint account. */
  ownerId: string | null
  mode: InvestmentMode
}

/** What an investment account is until someone says otherwise. */
export const DEFAULT_INVESTMENT_SETTINGS: InvestmentSettings = {
  kind: 'brokerage',
  taxType: 'taxable',
  ownerId: null,
  mode: 'units',
}

/** A dated market value for an account, in integer cents. One per account per day. */
export interface Valuation {
  id: string
  accountId: string
  /** `YYYY-MM-DD` */
  date: string
  marketValue: number
  /** `manual` was typed by a person; `sync` was reported by the bank. */
  source: 'manual' | 'sync'
}

export interface InvestmentAccount extends InvestmentSettings {
  accountId: string
  name: string
  closed: boolean
  /** The newest valuation, or null when none has been recorded. */
  latestValuation: Valuation | null
}

/** A balance the bank reported, as the server fetched it. */
export interface BankBalance {
  /** The bank's id for the account (what `mapExternalAccount` links). */
  externalId: string
  /** Integer cents. */
  balance: number
  /** When the bank reported it, as an ISO timestamp; today when the bank did not say. */
  balanceDate: string | null
}

export interface InvestmentsApi {
  /** Every investment account with its settings and newest valuation, oldest account first. */
  listInvestmentAccounts(): Promise<InvestmentAccount[]>
  updateInvestmentSettings(
    accountId: string,
    changes: Partial<InvestmentSettings>,
  ): Promise<InvestmentAccount>
  /** Newest first. */
  listValuations(accountId: string): Promise<Valuation[]>
  /**
   * Records what an account is worth on a day. A day already valued is overwritten, so this
   * is also how a wrong entry is corrected.
   */
  recordValuation(input: {
    accountId: string
    date: string
    marketValue: number
  }): Promise<Valuation>
  deleteValuation(id: string): Promise<void>
  /**
   * Records the balances of bank accounts that are linked to investment accounts as that
   * day's valuation. A day a person already valued by hand is left as they entered it.
   * Returns how many valuations were written.
   */
  recordBankBalances(balances: BankBalance[]): Promise<number>
}

interface SettingsRow {
  kind: InvestmentKind
  tax_type: TaxType
  owner_member_id: string | null
  mode: InvestmentMode
}

interface ValuationRow {
  id: string
  account_id: string
  date: string
  market_value: number
  source: 'manual' | 'sync'
}

const toValuation = (r: ValuationRow): Valuation => ({
  id: r.id,
  accountId: r.account_id,
  date: r.date,
  marketValue: r.market_value,
  source: r.source,
})

const VALUATION_COLUMNS = 'id, account_id, date, market_value, source'

/** The same account on the same day is the same row on every device. */
const valuationId = (accountId: string, date: string) => `valuation-${accountId}:${date}`

function assertSettings(settings: Partial<InvestmentSettings>) {
  if (settings.kind !== undefined && !INVESTMENT_KINDS.includes(settings.kind)) {
    throw new Error(`Unknown account kind "${String(settings.kind)}"`)
  }
  if (settings.taxType !== undefined && !TAX_TYPES.includes(settings.taxType)) {
    throw new Error(`Unknown tax type "${String(settings.taxType)}"`)
  }
  if (settings.mode !== undefined && !INVESTMENT_MODES.includes(settings.mode)) {
    throw new Error(`Unknown mode "${String(settings.mode)}"`)
  }
}

const KIND_NAMES: Record<InvestmentKind, string> = {
  brokerage: 'A brokerage account',
  ira: 'An IRA',
  '401k': 'A 401(k)',
  '403b': 'A 403(b)',
  '457': 'A 457 plan',
  '401a': 'A 401(a)',
  'sep-ira': 'A SEP IRA',
  'simple-ira': 'A SIMPLE IRA',
  '529': 'A 529 plan',
  other: 'This account',
}

function assertCompatible({ kind, taxType }: Pick<InvestmentSettings, 'kind' | 'taxType'>) {
  if (taxTypesFor(kind).includes(taxType)) return
  throw new Error(`${KIND_NAMES[kind]} can’t be ${taxType}`)
}

async function assertOwner(db: SqlRunner, ownerId: string | null) {
  if (ownerId === null) return
  const [member] = await db.query('SELECT 1 AS x FROM members WHERE id = ?', [ownerId])
  if (!member) throw new Error('Owner not found')
}

/** Writes the settings row for a new investment account (its id is the account's id). */
export async function createInvestmentSettings(
  db: SqlRunner,
  changes: ChangeLog,
  accountId: string,
  settings: Partial<InvestmentSettings>,
  at: string,
) {
  assertSettings(settings)
  const kind = settings.kind ?? DEFAULT_INVESTMENT_SETTINGS.kind
  const merged = {
    ...DEFAULT_INVESTMENT_SETTINGS,
    ...settings,
    kind,
    // asked only for a kind, the account gets that kind's usual tax type
    taxType: settings.taxType ?? taxTypeFor(kind),
  }
  assertCompatible(merged)
  await assertOwner(db, merged.ownerId)
  await changes.insert('investment_accounts', {
    id: accountId,
    kind: merged.kind,
    tax_type: merged.taxType,
    owner_member_id: merged.ownerId,
    mode: merged.mode,
    created_at: at,
  })
}

/** Removes an account's settings and valuations along with the account. */
export async function dropInvestmentData(db: SqlRunner, changes: ChangeLog, accountId: string) {
  await dropUnitData(db, changes, accountId)
  const valuations = await db.query<{ id: string }>(
    'SELECT id FROM account_valuations WHERE account_id = ?',
    [accountId],
  )
  for (const v of valuations) await changes.delete('account_valuations', v.id)
  const [settings] = await db.query('SELECT 1 AS x FROM investment_accounts WHERE id = ?', [
    accountId,
  ])
  if (settings) await changes.delete('investment_accounts', accountId)
}

function assertValue(marketValue: number) {
  if (!Number.isSafeInteger(marketValue) || marketValue < 0) {
    throw new Error('A value must be a whole number of cents, zero or more')
  }
}

export function investmentsApi({ adapter, now, changes: log }: CrudDeps): InvestmentsApi {
  async function investmentAccount(db: SqlRunner, id: string): Promise<InvestmentAccount> {
    const [row] = await db.query<
      Partial<SettingsRow> & { id: string; name: string; type: string; closed: number }
    >(
      `SELECT a.id, a.name, a.type, a.closed, i.kind, i.tax_type, i.owner_member_id, i.mode
       FROM accounts a LEFT JOIN investment_accounts i ON i.id = a.id WHERE a.id = ?`,
      [id],
    )
    if (!row) throw new Error('Account not found')
    if (row.type !== 'investment') throw new Error('This is not an investment account')
    const [latest] = await db.query<ValuationRow & Record<string, never>>(
      `SELECT ${VALUATION_COLUMNS} FROM account_valuations WHERE account_id = ?
       ORDER BY date DESC, id LIMIT 1`,
      [id],
    )
    return {
      accountId: row.id,
      name: row.name,
      closed: row.closed === 1,
      kind: row.kind ?? DEFAULT_INVESTMENT_SETTINGS.kind,
      taxType: row.tax_type ?? DEFAULT_INVESTMENT_SETTINGS.taxType,
      ownerId: row.owner_member_id ?? DEFAULT_INVESTMENT_SETTINGS.ownerId,
      mode: row.mode ?? DEFAULT_INVESTMENT_SETTINGS.mode,
      latestValuation: latest ? toValuation(latest) : null,
    }
  }

  /** Inserts or overwrites the valuation for a day. Null when `keepManual` held it back. */
  async function save(
    tx: SqlRunner,
    input: { accountId: string; date: string; marketValue: number; source: Valuation['source'] },
    keepManual = false,
  ): Promise<Valuation | null> {
    const id = valuationId(input.accountId, input.date)
    const [existing] = await tx.query<ValuationRow & Record<string, never>>(
      `SELECT ${VALUATION_COLUMNS} FROM account_valuations WHERE id = ?`,
      [id],
    )
    if (existing && keepManual && existing.source === 'manual') return null
    const changes = log(tx)
    if (existing) {
      await changes.update('account_valuations', id, {
        market_value: input.marketValue,
        source: input.source,
      })
    } else {
      await changes.insert('account_valuations', {
        id,
        account_id: input.accountId,
        date: input.date,
        market_value: input.marketValue,
        source: input.source,
        created_at: now(),
      })
    }
    return {
      id,
      accountId: input.accountId,
      date: input.date,
      marketValue: input.marketValue,
      source: input.source,
    }
  }

  return {
    async listInvestmentAccounts() {
      const ids = await adapter.query<{ id: string }>(
        `SELECT id FROM accounts WHERE type = 'investment' ORDER BY created_at, id`,
      )
      const accounts: InvestmentAccount[] = []
      for (const { id } of ids) accounts.push(await investmentAccount(adapter, id))
      return accounts
    },

    async updateInvestmentSettings(accountId, patch) {
      assertSettings(patch)
      return adapter.transaction(async (tx) => {
        const current = await investmentAccount(tx, accountId)
        const kind = patch.kind ?? current.kind
        const next = {
          kind,
          // a new kind that does not allow the current tax type moves to its usual one
          taxType: patch.taxType ?? taxTypeFor(kind, current.taxType),
          ownerId: patch.ownerId === undefined ? current.ownerId : patch.ownerId,
          mode: patch.mode ?? current.mode,
        }
        assertCompatible(next)
        if (next.ownerId !== current.ownerId) await assertOwner(tx, next.ownerId)
        const changes = log(tx)
        const [stored] = await tx.query('SELECT 1 AS x FROM investment_accounts WHERE id = ?', [
          accountId,
        ])
        if (stored) {
          await changes.update('investment_accounts', accountId, {
            kind: next.kind,
            tax_type: next.taxType,
            owner_member_id: next.ownerId,
            mode: next.mode,
          })
        } else {
          // An account made before settings existed has no row until its first change.
          await createInvestmentSettings(tx, changes, accountId, next, now())
        }
        return investmentAccount(tx, accountId)
      })
    },

    async listValuations(accountId) {
      const rows = await adapter.query<ValuationRow & Record<string, never>>(
        `SELECT ${VALUATION_COLUMNS} FROM account_valuations WHERE account_id = ?
         ORDER BY date DESC, id`,
        [accountId],
      )
      return rows.map(toValuation)
    },

    async recordValuation({ accountId, date, marketValue }) {
      assertDate(date)
      assertValue(marketValue)
      return adapter.transaction(async (tx) => {
        await investmentAccount(tx, accountId)
        return (await save(tx, { accountId, date, marketValue, source: 'manual' }))!
      })
    },

    async deleteValuation(id) {
      await adapter.transaction(async (tx) => {
        const [row] = await tx.query('SELECT 1 AS x FROM account_valuations WHERE id = ?', [id])
        if (!row) throw new Error('Valuation not found')
        await log(tx).delete('account_valuations', id)
      })
    },

    async recordBankBalances(balances) {
      return adapter.transaction(async (tx) => {
        let written = 0
        for (const bank of balances) {
          if (!Number.isSafeInteger(bank.balance) || bank.balance < 0) continue
          const [target] = await tx.query<{ id: string }>(
            `SELECT a.id FROM external_accounts e JOIN accounts a ON a.id = e.account_id
             WHERE e.id = ? AND a.type = 'investment' AND a.closed = 0`,
            [bank.externalId],
          )
          if (!target) continue
          const date = bank.balanceDate?.slice(0, 10) ?? now().slice(0, 10)
          assertDate(date)
          const saved = await save(
            tx,
            { accountId: target.id, date, marketValue: bank.balance, source: 'sync' },
            true,
          )
          if (saved) written++
        }
        return written
      })
    },
  }
}
