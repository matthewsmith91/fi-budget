import type { ChangeLog } from './changes.ts'
import { ADJUSTMENT_PAYEE, assertDate, cleanName, type CrudDeps } from './crud.ts'
import type { SqlRunner } from './storage.ts'

export const UNIT_EVENT_TYPES = ['buy', 'sell', 'dividend', 'move_in', 'move_out'] as const
export type UnitEventType = (typeof UNIT_EVENT_TYPES)[number]

/** Units are stored in millionths so sums are exact. */
const MICRO = 1_000_000
/** Cents per unit when an account has no value to price its units from: a unit is $1. */
const OPENING_PRICE = 100
/** Passed where no transaction's rows are to be left out (no transaction has this id). */
const NO_TRANSACTION = '-'

const SIGNED_UNITS = `SUM(CASE WHEN type IN ('buy', 'dividend', 'move_in') THEN units ELSE -units END)`
const SIGNED_BASIS = `SUM(CASE WHEN type IN ('buy', 'dividend', 'move_in') THEN basis ELSE -basis END)`

/** One line of the unit ledger. */
export interface UnitEvent {
  id: string
  accountId: string
  /** The goal that owns the units; null is the account's Unassigned part (or a holding's). */
  goalId: string | null
  holdingId: string | null
  type: UnitEventType
  /** Whole units (or shares), up to six decimals. */
  units: number
  /** Cents per unit when the row was written. */
  unitPrice: number
  /** Cash value in cents. */
  amount: number
  /** Cost of these units in cents; for a sell, the cost that left with them. */
  basis: number
  date: string
  /** `transaction`: made from a transfer or dividend; `opening`: the account's starting value; `manual`: entered by a person. */
  source: 'transaction' | 'opening' | 'manual'
}

/** One investment a goal owns in a holdings-mode account. */
export interface Holding {
  id: string
  accountId: string
  /** Null is the account's Unassigned part. */
  goalId: string | null
  name: string
  /** Cents per share, the latest one entered; null until a price is entered. */
  price: number | null
  priceDate: string | null
}

export interface HoldingFigures extends Holding {
  shares: number
  /** Shares × price; 0 while the holding has no price. */
  value: number
  costBasis: number
  gain: number
  realized: number
}

/** What one goal (or the Unassigned part) owns in an account. */
export interface GoalInvestment {
  goalId: string | null
  /** Null for the Unassigned part. */
  goalName: string | null
  /** Units of the shared pool; holdings are listed apart. */
  units: number
  /** Pool units × unit price, plus the holdings' value. */
  value: number
  costBasis: number
  /** `value - costBasis`. */
  gain: number
  /** Gain locked in by sells (and sold holdings). */
  realized: number
  holdings: HoldingFigures[]
}

export interface AccountInvestments {
  accountId: string
  mode: 'units' | 'holdings'
  /** Cents per unit of the shared pool now; null before the pool has any units. */
  unitPrice: number | null
  /** The valuation the unit price comes from. */
  priceDate: string | null
  /** The account's newest valuation in cents, as typed or reported by the bank. */
  accountValue: number | null
  value: number
  costBasis: number
  gain: number
  realized: number
  goals: GoalInvestment[]
}

export interface UnitLedgerApi {
  /** What each goal owns of an investment account: value, cost basis, gain and realized gain. */
  getAccountInvestments(accountId: string): Promise<AccountInvestments>
  /** Newest first; the rows a transaction made are included, voided ones are not. */
  listUnitEvents(accountId: string): Promise<UnitEvent[]>
  /**
   * Moves `amount` cents of an account's pool from one goal to another (null is Unassigned)
   * at the unit price of `date`. The cost basis goes with the units and nothing is realized.
   */
  moveUnits(input: {
    accountId: string
    fromGoalId: string | null
    toGoalId: string | null
    date: string
    amount: number
  }): Promise<void>
  /** Removes an entry a person made (both sides of a move, or a trade); not one a transaction made. */
  deleteUnitEntry(eventId: string): Promise<void>
  /**
   * Walks an account's transactions oldest first and makes the unit rows they call for.
   * For history that was entered before the ledger existed. Safe to repeat.
   */
  rebuildUnitLedger(accountId: string): Promise<{ events: number }>
  listHoldings(accountId: string): Promise<Holding[]>
  /** `price` is cents per share and may have fractions of a cent. */
  createHolding(input: {
    accountId: string
    name: string
    goalId?: string | null
    price?: number | null
  }): Promise<Holding>
  updateHolding(
    id: string,
    changes: { name?: string; goalId?: string | null; price?: number | null; priceDate?: string },
  ): Promise<Holding>
  /** Only a holding with no trades; others stay for their history. */
  deleteHolding(id: string): Promise<void>
  /**
   * Buys or sells shares of a holding at `price` cents a share. It also becomes the holding's
   * latest price when it is newer than the one on file.
   */
  recordTrade(input: {
    holdingId: string
    type: 'buy' | 'sell'
    date: string
    shares: number
    price: number
  }): Promise<void>
}

type EventRow = {
  id: string
  account_id: string
  goal_id: string | null
  holding_id: string | null
  transaction_id: string | null
  batch_id: string | null
  type: UnitEventType
  units: number
  unit_price: number
  amount: number
  basis: number
  date: string
  voided: number
}

const EVENT_COLUMNS =
  'id, account_id, goal_id, holding_id, transaction_id, batch_id, type, units, unit_price, amount, basis, date, voided'

type HoldingRow = {
  id: string
  account_id: string
  goal_id: string | null
  name: string
  price: number | null
  price_date: string | null
}

const toHolding = (r: HoldingRow): Holding => ({
  id: r.id,
  accountId: r.account_id,
  goalId: r.goal_id,
  name: r.name,
  price: r.price,
  priceDate: r.price_date,
})

const openingId = (accountId: string) => `unit-open-${accountId}`
const eventId = (transactionId: string) => `unit-${transactionId}`

/** Cents that `micro` millionths of a unit are worth at `price` cents a unit. */
const worth = (micro: number, price: number) => Math.round((micro * price) / MICRO)
/** Millionths of a unit that `amount` cents buys at `price` cents a unit. */
const unitsFor = (amount: number, price: number) => Math.round((amount * MICRO) / price)

interface Position {
  units: number
  basis: number
}

/** What a goal (null: Unassigned) or a holding holds, counting rows dated on or before `upTo`. */
async function position(
  db: SqlRunner,
  who: { accountId: string; goalId: string | null } | { holdingId: string },
  upTo: string,
  exceptTransaction: string,
): Promise<Position> {
  const [row] = await db.query<{ units: number | null; basis: number | null }>(
    `SELECT ${SIGNED_UNITS} AS units, ${SIGNED_BASIS} AS basis FROM unit_events
     WHERE ${'holdingId' in who ? 'holding_id = ?' : 'account_id = ? AND holding_id IS NULL AND goal_id IS ?'}
       AND voided = 0 AND date <= ? AND COALESCE(transaction_id, '') <> ?`,
    [
      'holdingId' in who ? who.holdingId : who.accountId,
      ...('holdingId' in who ? [] : [who.goalId]),
      upTo,
      exceptTransaction,
    ],
  )
  return { units: row?.units ?? 0, basis: row?.basis ?? 0 }
}

async function poolUnits(
  db: SqlRunner,
  accountId: string,
  upTo: string,
  exceptTransaction: string,
): Promise<number> {
  const [row] = await db.query<{ units: number | null }>(
    `SELECT ${SIGNED_UNITS} AS units FROM unit_events
     WHERE account_id = ? AND holding_id IS NULL AND voided = 0 AND date <= ?
       AND COALESCE(transaction_id, '') <> ?`,
    [accountId, upTo, exceptTransaction],
  )
  return row?.units ?? 0
}

/**
 * Cents per unit of an account's shared pool on `date`: the newest valuation on or before
 * it divided by the units that existed when it was taken, so what came in or went out since
 * leaves the price alone. Without a usable valuation it is the price of the latest row, or
 * $1 for a pool that has never had one.
 */
async function poolPrice(
  db: SqlRunner,
  accountId: string,
  date: string,
  exceptTransaction: string,
): Promise<number> {
  const [valuation] = await db.query<{ date: string; market_value: number }>(
    `SELECT date, market_value FROM account_valuations WHERE account_id = ? AND date <= ?
     ORDER BY date DESC, id LIMIT 1`,
    [accountId, date],
  )
  if (valuation && valuation.market_value > 0) {
    const units = await poolUnits(db, accountId, valuation.date, exceptTransaction)
    if (units > 0) return (valuation.market_value * MICRO) / units
  }
  const [last] = await db.query<{ unit_price: number }>(
    `SELECT unit_price FROM unit_events
     WHERE account_id = ? AND holding_id IS NULL AND voided = 0 AND date <= ?
       AND COALESCE(transaction_id, '') <> ?
     ORDER BY date DESC, created_at DESC, id DESC LIMIT 1`,
    [accountId, date, exceptTransaction],
  )
  return last?.unit_price ?? OPENING_PRICE
}

/**
 * The first time an account's pool is used, what the account was already worth belongs to
 * no goal: it becomes Unassigned units at $1 each, dated from the valuation. Without it the
 * first contribution would own the whole account.
 */
async function ensureOpening(
  db: SqlRunner,
  changes: ChangeLog,
  accountId: string,
  date: string,
  at: string,
) {
  const [any] = await db.query(
    'SELECT 1 AS x FROM unit_events WHERE account_id = ? AND holding_id IS NULL LIMIT 1',
    [accountId],
  )
  if (any) return
  const [valuation] = await db.query<{ date: string; market_value: number }>(
    `SELECT date, market_value FROM account_valuations
     WHERE account_id = ? AND date <= ? AND market_value > 0 ORDER BY date DESC, id LIMIT 1`,
    [accountId, date],
  )
  if (!valuation) return
  await changes.insert('unit_events', {
    id: openingId(accountId),
    account_id: accountId,
    type: 'buy',
    units: unitsFor(valuation.market_value, OPENING_PRICE),
    unit_price: OPENING_PRICE,
    amount: valuation.market_value,
    basis: valuation.market_value,
    date: valuation.date,
    voided: 0,
    created_at: at,
  })
}

/** `take` of a position's units sold for `amount` cents of the `wanted` units: proceeds and cost out. */
function sellOf(pos: Position, take: number, wanted: number, amount: number) {
  return {
    units: take,
    amount: take === wanted ? amount : Math.round((amount * take) / wanted),
    basis: take === pos.units ? pos.basis : Math.round((pos.basis * take) / pos.units),
  }
}

interface Built {
  id: string
  goalId: string | null
  holdingId: string | null
  type: UnitEventType
  units: number
  unitPrice: number
  amount: number
  basis: number
}

interface Leg {
  accountId: string
  date: string
  amount: number
  cleared: boolean
  approved: boolean
  payee: string | null
  transferPairId: string | null
  accountType: string
  mode: 'units' | 'holdings'
}

async function loadLeg(db: SqlRunner, id: string): Promise<Leg | null> {
  const [row] = await db.query<{
    account_id: string
    date: string
    amount: number
    cleared: number
    approved: number
    payee: string | null
    transfer_pair_id: string | null
    account_type: string
    mode: 'units' | 'holdings'
  }>(
    `SELECT t.account_id, t.date, t.amount, t.cleared, t.approved, t.payee, t.transfer_pair_id,
       a.type AS account_type, COALESCE(i.mode, 'units') AS mode
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     LEFT JOIN investment_accounts i ON i.id = t.account_id WHERE t.id = ?`,
    [id],
  )
  if (!row) return null
  return {
    accountId: row.account_id,
    date: row.date,
    amount: row.amount,
    cleared: row.cleared === 1,
    approved: row.approved === 1,
    payee: row.payee,
    transferPairId: row.transfer_pair_id,
    accountType: row.account_type,
    mode: row.mode,
  }
}

/**
 * What a transaction in an investment account does to the ledger, or null when it does
 * nothing (not cleared, not approved, not a contribution or withdrawal or dividend).
 * A transfer buys or sells units for the goal on the other leg; a dividend is an inflow
 * that is not a transfer and goes to Unassigned.
 */
async function wantedFor(db: SqlRunner, id: string, leg: Leg) {
  if (leg.accountType !== 'investment' || !leg.cleared || !leg.approved) return null
  if (leg.payee === ADJUSTMENT_PAYEE) return null
  if (leg.transferPairId === null) {
    return leg.amount > 0 ? { type: 'dividend' as const, goalId: null, amount: leg.amount } : null
  }
  const [other] = await db.query<{ goal_id: string | null }>(
    `SELECT (SELECT s.goal_id FROM transaction_splits s WHERE s.transaction_id = t.id
             ORDER BY s.rowid LIMIT 1) AS goal_id
     FROM transactions t WHERE t.transfer_pair_id = ? AND t.id <> ?`,
    [leg.transferPairId, id],
  )
  if (!other) return null
  return {
    type: leg.amount > 0 ? ('buy' as const) : ('sell' as const),
    goalId: other.goal_id,
    amount: Math.abs(leg.amount),
  }
}

/**
 * The rows a transaction should have, given what the ledger holds without them. A price
 * already written for the same day and direction is kept, so editing an amount does not
 * re-price a purchase.
 */
async function build(
  db: SqlRunner,
  changes: ChangeLog,
  at: string,
  id: string,
  leg: Leg,
  want: { type: 'buy' | 'sell' | 'dividend'; goalId: string | null; amount: number },
  existing: EventRow[],
): Promise<Built[]> {
  const primary = eventId(id)
  const kept = existing.find((e) => e.id === primary && e.voided === 0)
  const sameDay = kept && kept.date === leg.date && kept.type === want.type ? kept : null

  if (leg.mode === 'holdings') {
    if (want.type === 'dividend') return []
    // Without a choice of holding there is nothing to say which one was traded.
    const holdings = await db.query<{ id: string; price: number | null }>(
      `SELECT id, price FROM holdings WHERE account_id = ? AND goal_id IS ?`,
      [leg.accountId, want.goalId],
    )
    const [only, ...more] = holdings
    if (!only || more.length > 0 || only.price === null) return []
    const price = sameDay?.unit_price ?? only.price
    return tradeBuilt(
      want.type,
      { id: primary, goalId: null, holdingId: only.id },
      price,
      want.amount,
      await position(db, { holdingId: only.id }, leg.date, id),
    )
  }

  await ensureOpening(db, changes, leg.accountId, leg.date, at)
  const price = sameDay?.unit_price ?? (await poolPrice(db, leg.accountId, leg.date, id))
  if (want.type !== 'sell') {
    return tradeBuilt(
      want.type,
      { id: primary, goalId: want.type === 'dividend' ? null : want.goalId, holdingId: null },
      price,
      want.amount,
      null,
    )
  }
  // A sell comes out of the goal first; what it does not hold comes out of Unassigned.
  const wanted = unitsFor(want.amount, price)
  const own = await position(db, { accountId: leg.accountId, goalId: want.goalId }, leg.date, id)
  const out: Built[] = []
  const first = Math.min(wanted, own.units)
  const left = wanted - first
  if (first > 0) {
    const s = sellOf(own, first, wanted, want.amount)
    out.push({
      id: primary,
      goalId: want.goalId,
      holdingId: null,
      type: 'sell',
      unitPrice: price,
      ...s,
    })
  }
  if (left > 0 && want.goalId !== null) {
    const rest = await position(db, { accountId: leg.accountId, goalId: null }, leg.date, id)
    const take = Math.min(left, rest.units)
    if (take > 0) {
      const s = sellOf(rest, take, wanted, want.amount)
      out.push({
        id: `${primary}-unassigned`,
        goalId: null,
        holdingId: null,
        type: 'sell',
        unitPrice: price,
        ...s,
      })
    }
  }
  return out
}

function tradeBuilt(
  type: 'buy' | 'sell' | 'dividend',
  where: { id: string; goalId: string | null; holdingId: string | null },
  price: number,
  amount: number,
  held: Position | null,
): Built[] {
  if (type !== 'sell') {
    return [
      { ...where, type, unitPrice: price, units: unitsFor(amount, price), amount, basis: amount },
    ]
  }
  const wanted = unitsFor(amount, price)
  const take = Math.min(wanted, held?.units ?? 0)
  if (take <= 0 || !held) return []
  return [{ ...where, type, unitPrice: price, ...sellOf(held, take, wanted, amount) }]
}

async function settleOne(db: SqlRunner, changes: ChangeLog, at: string, id: string) {
  const existing = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM unit_events WHERE transaction_id = ? ORDER BY id`,
    [id],
  )
  const leg = await loadLeg(db, id)
  if (!leg) {
    // The transaction is gone for good, so its rows can be too.
    for (const e of existing) await changes.delete('unit_events', e.id)
    return
  }
  if (leg.accountType !== 'investment' && existing.length === 0) return
  const want = await wantedFor(db, id, leg)
  const built = want ? await build(db, changes, at, id, leg, want, existing) : []
  const current = new Map(existing.map((e) => [e.id, e]))
  for (const b of built) {
    const row = {
      goal_id: b.goalId,
      holding_id: b.holdingId,
      type: b.type,
      units: b.units,
      unit_price: b.unitPrice,
      amount: b.amount,
      basis: b.basis,
      date: leg.date,
      voided: 0,
    }
    if (current.has(b.id)) await changes.update('unit_events', b.id, row)
    else {
      await changes.insert('unit_events', {
        id: b.id,
        account_id: leg.accountId,
        transaction_id: id,
        created_at: at,
        ...row,
      })
    }
  }
  // Not cleared (or no longer a contribution): keep the row, since a delete is permanent
  // and the transaction may be cleared again.
  const keep = new Set(built.map((b) => b.id))
  for (const e of existing) {
    if (!keep.has(e.id) && e.voided === 0) await changes.update('unit_events', e.id, { voided: 1 })
  }
}

/**
 * Brings the unit ledger in line with the given transactions: a cleared transfer into an
 * investment account buys units for the goal on its budget leg, a cleared transfer out
 * sells them, and a cleared inflow that is not a transfer is a dividend for Unassigned.
 * Safe to run for any transaction, in any account, as often as needed.
 */
export async function settleUnits(
  db: SqlRunner,
  changes: ChangeLog,
  at: string,
  ids: readonly (string | null | undefined)[],
) {
  for (const id of new Set(ids)) if (id) await settleOne(db, changes, at, id)
}

/** Removes an account's unit rows and holdings along with the account. */
export async function dropUnitData(db: SqlRunner, changes: ChangeLog, accountId: string) {
  for (const table of ['unit_events', 'holdings']) {
    const rows = await db.query<{ id: string }>(`SELECT id FROM ${table} WHERE account_id = ?`, [
      accountId,
    ])
    for (const r of rows) await changes.delete(table, r.id)
  }
}

/** Whether any unit row or holding refers to the goal (a goal with them keeps its history). */
export async function goalHasUnits(db: SqlRunner, goalId: string): Promise<boolean> {
  const [row] = await db.query(
    `SELECT 1 AS x FROM unit_events WHERE goal_id = ?
     UNION ALL SELECT 1 FROM holdings WHERE goal_id = ? LIMIT 1`,
    [goalId, goalId],
  )
  return row !== undefined
}

export function unitLedgerApi({ adapter, newId, now, changes: log }: CrudDeps): UnitLedgerApi {
  async function investmentAccount(db: SqlRunner, id: string) {
    const [row] = await db.query<{ type: string; mode: 'units' | 'holdings' }>(
      `SELECT a.type, COALESCE(i.mode, 'units') AS mode FROM accounts a
       LEFT JOIN investment_accounts i ON i.id = a.id WHERE a.id = ?`,
      [id],
    )
    if (!row) throw new Error('Account not found')
    if (row.type !== 'investment') throw new Error('This is not an investment account')
    return row
  }

  async function assertGoalExists(db: SqlRunner, id: string | null | undefined) {
    if (!id) return
    const [row] = await db.query('SELECT 1 AS x FROM goals WHERE id = ?', [id])
    if (!row) throw new Error('Goal not found')
  }

  async function getHolding(db: SqlRunner, id: string): Promise<Holding> {
    const [row] = await db.query<HoldingRow>(
      'SELECT id, account_id, goal_id, name, price, price_date FROM holdings WHERE id = ?',
      [id],
    )
    if (!row) throw new Error('Holding not found')
    return toHolding(row)
  }

  function assertPrice(price: number, what: string) {
    if (!Number.isFinite(price) || price <= 0) throw new Error(`${what} must be more than zero`)
  }

  async function investments(db: SqlRunner, accountId: string): Promise<AccountInvestments> {
    const { mode } = await investmentAccount(db, accountId)
    const [valuation] = await db.query<{ date: string; market_value: number }>(
      `SELECT date, market_value FROM account_valuations WHERE account_id = ?
       ORDER BY date DESC, id LIMIT 1`,
      [accountId],
    )
    const [anyPool] = await db.query(
      'SELECT 1 AS x FROM unit_events WHERE account_id = ? AND holding_id IS NULL AND voided = 0 LIMIT 1',
      [accountId],
    )
    const unitPrice = anyPool ? await poolPrice(db, accountId, '9999-12-31', NO_TRANSACTION) : null

    const pool = await db.query<{
      goal_id: string | null
      units: number
      basis: number
      realized: number
    }>(
      `SELECT goal_id, ${SIGNED_UNITS} AS units, ${SIGNED_BASIS} AS basis,
         SUM(CASE WHEN type = 'sell' THEN amount - basis ELSE 0 END) AS realized
       FROM unit_events WHERE account_id = ? AND holding_id IS NULL AND voided = 0
       GROUP BY goal_id`,
      [accountId],
    )
    const holdings = await db.query<HoldingRow>(
      `SELECT id, account_id, goal_id, name, price, price_date FROM holdings
       WHERE account_id = ? ORDER BY created_at, id`,
      [accountId],
    )
    const traded = await db.query<{
      holding_id: string
      shares: number
      basis: number
      realized: number
    }>(
      `SELECT holding_id, ${SIGNED_UNITS} AS shares, ${SIGNED_BASIS} AS basis,
         SUM(CASE WHEN type = 'sell' THEN amount - basis ELSE 0 END) AS realized
       FROM unit_events WHERE account_id = ? AND holding_id IS NOT NULL AND voided = 0
       GROUP BY holding_id`,
      [accountId],
    )
    const tradedBy = new Map(traded.map((t) => [t.holding_id, t]))
    const goals = await db.query<{ id: string; name: string }>(
      'SELECT id, name FROM goals ORDER BY created_at, id',
    )

    const rows = new Map<string, GoalInvestment>()
    const rowFor = (goalId: string | null) => {
      const key = goalId ?? ''
      let row = rows.get(key)
      if (!row) {
        row = {
          goalId,
          goalName: goals.find((g) => g.id === goalId)?.name ?? null,
          units: 0,
          value: 0,
          costBasis: 0,
          gain: 0,
          realized: 0,
          holdings: [],
        }
        rows.set(key, row)
      }
      return row
    }
    for (const p of pool) {
      const row = rowFor(p.goal_id)
      row.units = p.units / MICRO
      row.value = unitPrice === null ? 0 : worth(p.units, unitPrice)
      row.costBasis = p.basis
      row.realized = p.realized
    }
    for (const h of holdings) {
      const t = tradedBy.get(h.id)
      const shares = t?.shares ?? 0
      const value = h.price === null ? 0 : worth(shares, h.price)
      const figures: HoldingFigures = {
        ...toHolding(h),
        shares: shares / MICRO,
        value,
        costBasis: t?.basis ?? 0,
        gain: value - (t?.basis ?? 0),
        realized: t?.realized ?? 0,
      }
      const row = rowFor(h.goal_id)
      row.holdings.push(figures)
      row.value += figures.value
      row.costBasis += figures.costBasis
      row.realized += figures.realized
    }
    // Goals in the order they were made, Unassigned last; a goal that owns nothing is left out.
    const order = [...goals.map((g) => g.id), null]
    const list: GoalInvestment[] = []
    for (const goalId of order) {
      const row = rows.get(goalId ?? '')
      if (!row) continue
      row.gain = row.value - row.costBasis
      list.push(row)
    }
    const sum = (pick: (g: GoalInvestment) => number) => list.reduce((n, g) => n + pick(g), 0)
    return {
      accountId,
      mode,
      unitPrice,
      priceDate: valuation?.date ?? null,
      accountValue: valuation?.market_value ?? null,
      value: sum((g) => g.value),
      costBasis: sum((g) => g.costBasis),
      gain: sum((g) => g.gain),
      realized: sum((g) => g.realized),
      goals: list,
    }
  }

  return {
    getAccountInvestments: (accountId) => adapter.transaction((tx) => investments(tx, accountId)),

    async listUnitEvents(accountId) {
      await investmentAccount(adapter, accountId)
      const rows = await adapter.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM unit_events WHERE account_id = ? AND voided = 0
         ORDER BY date DESC, created_at DESC, id DESC`,
        [accountId],
      )
      return rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        goalId: r.goal_id,
        holdingId: r.holding_id,
        type: r.type,
        units: r.units / MICRO,
        unitPrice: r.unit_price,
        amount: r.amount,
        basis: r.basis,
        date: r.date,
        source:
          r.transaction_id !== null
            ? 'transaction'
            : r.id === openingId(r.account_id)
              ? 'opening'
              : 'manual',
      }))
    },

    async moveUnits({ accountId, fromGoalId, toGoalId, date, amount }) {
      assertDate(date)
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error('Enter a positive amount to move')
      }
      if (fromGoalId === toGoalId) throw new Error('Pick two different goals')
      await adapter.transaction(async (tx) => {
        const account = await investmentAccount(tx, accountId)
        if (account.mode !== 'units') {
          throw new Error('Units move between goals only in a units-mode account')
        }
        await assertGoalExists(tx, fromGoalId)
        await assertGoalExists(tx, toGoalId)
        const changes = log(tx)
        const at = now()
        await ensureOpening(tx, changes, accountId, date, at)
        const price = await poolPrice(tx, accountId, date, NO_TRANSACTION)
        const wanted = unitsFor(amount, price)
        const held = await position(tx, { accountId, goalId: fromGoalId }, date, NO_TRANSACTION)
        // A cent of rounding is tolerated so "move everything it shows" works.
        if (wanted > held.units + Math.ceil(MICRO / price)) {
          throw new Error('That goal doesn’t own that much of the account')
        }
        const take = Math.min(wanted, held.units)
        if (take <= 0) throw new Error('That goal doesn’t own any of the account')
        const basis =
          take === held.units ? held.basis : Math.round((held.basis * take) / held.units)
        const batch = newId()
        for (const [type, goalId] of [
          ['move_out', fromGoalId],
          ['move_in', toGoalId],
        ] as const) {
          await changes.insert('unit_events', {
            id: newId(),
            account_id: accountId,
            goal_id: goalId,
            batch_id: batch,
            type,
            units: take,
            unit_price: price,
            amount,
            basis,
            date,
            voided: 0,
            created_at: at,
          })
        }
      })
    },

    async deleteUnitEntry(id) {
      await adapter.transaction(async (tx) => {
        const [row] = await tx.query<{
          transaction_id: string | null
          batch_id: string | null
          account_id: string
        }>('SELECT transaction_id, batch_id, account_id FROM unit_events WHERE id = ?', [id])
        if (!row) throw new Error('Entry not found')
        if (row.transaction_id !== null || id === openingId(row.account_id)) {
          throw new Error('That entry comes from a transaction; change the transaction instead')
        }
        const rows = row.batch_id
          ? await tx.query<{ id: string }>('SELECT id FROM unit_events WHERE batch_id = ?', [
              row.batch_id,
            ])
          : [{ id }]
        for (const r of rows) await log(tx).delete('unit_events', r.id)
      })
    },

    async rebuildUnitLedger(accountId) {
      return adapter.transaction(async (tx) => {
        await investmentAccount(tx, accountId)
        const ids = await tx.query<{ id: string }>(
          'SELECT id FROM transactions WHERE account_id = ? ORDER BY date, created_at, id',
          [accountId],
        )
        const changes = log(tx)
        const at = now()
        for (const { id } of ids) await settleUnits(tx, changes, at, [id])
        const [count] = await tx.query<{ n: number }>(
          'SELECT COUNT(*) AS n FROM unit_events WHERE account_id = ? AND transaction_id IS NOT NULL AND voided = 0',
          [accountId],
        )
        return { events: count?.n ?? 0 }
      })
    },

    async listHoldings(accountId) {
      const rows = await adapter.query<HoldingRow>(
        `SELECT id, account_id, goal_id, name, price, price_date FROM holdings
         WHERE account_id = ? ORDER BY created_at, id`,
        [accountId],
      )
      return rows.map(toHolding)
    },

    async createHolding({ accountId, name, goalId, price }) {
      const clean = cleanName(name, 'Holding')
      if (price !== null && price !== undefined) assertPrice(price, 'The price')
      return adapter.transaction(async (tx) => {
        await investmentAccount(tx, accountId)
        await assertGoalExists(tx, goalId)
        const id = newId()
        await log(tx).insert('holdings', {
          id,
          account_id: accountId,
          goal_id: goalId || null,
          name: clean,
          price: price ?? null,
          price_date: price ? now().slice(0, 10) : null,
          created_at: now(),
        })
        return getHolding(tx, id)
      })
    },

    async updateHolding(id, patch) {
      if (patch.price !== undefined && patch.price !== null) assertPrice(patch.price, 'The price')
      if (patch.priceDate !== undefined) assertDate(patch.priceDate)
      return adapter.transaction(async (tx) => {
        const current = await getHolding(tx, id)
        if (patch.goalId) await assertGoalExists(tx, patch.goalId)
        const priced = patch.price !== undefined
        await log(tx).update('holdings', id, {
          name: patch.name === undefined ? current.name : cleanName(patch.name, 'Holding'),
          goal_id: patch.goalId === undefined ? current.goalId : patch.goalId || null,
          price: priced ? patch.price! : current.price,
          price_date: priced
            ? patch.price === null
              ? null
              : (patch.priceDate ?? now().slice(0, 10))
            : current.priceDate,
        })
        return getHolding(tx, id)
      })
    },

    async deleteHolding(id) {
      await adapter.transaction(async (tx) => {
        await getHolding(tx, id)
        const [used] = await tx.query(
          'SELECT 1 AS x FROM unit_events WHERE holding_id = ? LIMIT 1',
          [id],
        )
        if (used) throw new Error('This holding has trades; set its goal elsewhere instead')
        await log(tx).delete('holdings', id)
      })
    },

    async recordTrade({ holdingId, type, date, shares, price }) {
      assertDate(date)
      assertPrice(shares, 'Shares')
      assertPrice(price, 'The price')
      if (type !== 'buy' && type !== 'sell') throw new Error('A trade is a buy or a sell')
      const micro = Math.round(shares * MICRO)
      if (micro <= 0) throw new Error('Shares must be more than zero')
      const amount = worth(micro, price)
      await adapter.transaction(async (tx) => {
        const holding = await getHolding(tx, holdingId)
        const changes = log(tx)
        let basis = amount
        if (type === 'sell') {
          const held = await position(tx, { holdingId }, date, NO_TRANSACTION)
          if (micro > held.units) throw new Error('That is more shares than the holding has')
          basis = micro === held.units ? held.basis : Math.round((held.basis * micro) / held.units)
        }
        const id = newId()
        await changes.insert('unit_events', {
          id,
          account_id: holding.accountId,
          holding_id: holdingId,
          batch_id: id,
          type,
          units: micro,
          unit_price: price,
          amount,
          basis,
          date,
          voided: 0,
          created_at: now(),
        })
        if (holding.priceDate === null || date >= holding.priceDate) {
          await changes.update('holdings', holdingId, { price, price_date: date })
        }
      })
    },
  }
}
