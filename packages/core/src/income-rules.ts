import { assertGoalUsable, assertMonth } from './allocations.ts'
import type { ChangeLog } from './changes.ts'
import { ADJUSTMENT_PAYEE, cleanName, type CrudDeps } from './crud.ts'
import { cents, percentOf } from './money.ts'
import { squashPayee } from './payee-rules.ts'
import type { SqlRunner } from './storage.ts'

export const INCOME_BASES = ['net', 'gross'] as const
export type IncomeBasis = (typeof INCOME_BASES)[number]

export interface IncomeRule {
  id: string
  name: string
  /** Words the payee must contain (see payee rules); null matches any payee. */
  match: string | null
  /** The account the deposit must land in; null matches any budget account. */
  accountId: string | null
  /** What a percent is taken of: the deposit, or the gross pay typed on it. */
  basis: IncomeBasis
  /** Percent of the basis, up to three decimals; null for a fixed amount. */
  percent: number | null
  /** Integer cents; null for a percent. */
  fixedAmount: number | null
  categoryId: string
  goalId: string | null
  /** Lower runs first. */
  priority: number
  createdAt: string
}

export interface NewIncomeRule {
  name: string
  match?: string | null
  accountId?: string | null
  basis?: IncomeBasis
  percent?: number | null
  fixedAmount?: number | null
  categoryId: string
  goalId?: string | null
  priority?: number
}

/** One rule's share of one deposit. */
export interface IncomeReportLine {
  ruleId: string
  ruleName: string
  categoryId: string
  goalId: string | null
  /** What the rule gives this deposit now, after any reversals. */
  expected: number
  /** What the ledger holds for this rule and deposit, in every month. */
  assigned: number
  /** A gross-basis percent on a deposit with no gross amount typed: nothing can be computed. */
  needsGross: boolean
}

export interface IncomeReportDeposit {
  transactionId: string
  accountId: string
  date: string
  payee: string | null
  /** What came in. */
  amount: number
  /** Taken back by transactions that reverse this one. */
  reversed: number
  gross: number | null
  lines: IncomeReportLine[]
  /** What no rule claims, left in Ready to Assign. */
  remainder: number
  /** True when every line's ledger matches what the rules give. */
  settled: boolean
}

export interface IncomeReportTarget {
  categoryId: string
  goalId: string | null
  /** What the rules give this month's deposits. */
  expected: number
  /** What rules have put there for this month's deposits. */
  fromRules: number
  /** Everything assigned there in the month, by hand or by rule. */
  assigned: number
}

export interface IncomeRulesReport {
  month: string
  deposits: IncomeReportDeposit[]
  targets: IncomeReportTarget[]
}

export interface IncomeRulesApi {
  /** Lowest priority first. */
  listIncomeRules(): Promise<IncomeRule[]>
  /**
   * A rule gives a percent of a deposit, or a fixed amount, to a category or goal whenever
   * income matching its payee and/or account is entered or approved. Every matching rule runs,
   * in priority order, and never gives away more than the deposit; the rest stays in Ready to
   * Assign. Past deposits are left alone until `applyIncomeRules`.
   */
  createIncomeRule(input: NewIncomeRule): Promise<IncomeRule>
  /** Takes effect on income entered or changed from now on; allocations already made stay. */
  updateIncomeRule(id: string, changes: Partial<NewIncomeRule>): Promise<IncomeRule>
  /** Allocations the rule already made stay in the ledger. */
  deleteIncomeRule(id: string): Promise<void>
  /**
   * Runs the rules over the income dated in `month` and tops up or reverses the allocations
   * so the ledger matches them. Safe to repeat. It does not look at amounts a person assigned
   * by hand, so run it only for months not already budgeted another way.
   */
  applyIncomeRules(month: string): Promise<{ deposits: number; allocations: number }>
  /** What the rules give each deposit in `month` beside what the ledger holds. */
  getIncomeRulesReport(month: string): Promise<IncomeRulesReport>
}

interface RuleRow {
  id: string
  name: string
  match: string | null
  account_id: string | null
  basis: IncomeBasis
  percent: number | null
  fixed_amount: number | null
  category_id: string
  goal_id: string | null
  priority: number
  created_at: string
}

const RULE_COLUMNS =
  'r.id, r.name, r.match, r.account_id, r.basis, r.percent, r.fixed_amount, r.category_id, r.goal_id, r.priority, r.created_at'

const toRule = (r: RuleRow): IncomeRule => ({
  id: r.id,
  name: r.name,
  match: r.match,
  accountId: r.account_id,
  basis: r.basis,
  percent: r.percent,
  fixedAmount: r.fixed_amount,
  categoryId: r.category_id,
  goalId: r.goal_id,
  priority: r.priority,
  createdAt: r.created_at,
})

const BY_PRIORITY = 'ORDER BY r.priority, r.created_at, r.id'

/** What a deposit gives the rules to work with. */
export interface Deposit {
  /** Cents that landed in the account (less anything reversed). */
  net: number
  /** The pre-tax pay typed on the deposit; null when it wasn't. */
  gross: number | null
}

export interface RuleShare<R> {
  rule: R
  /** Cents to give the rule's target; 0 when it gets nothing. */
  amount: number
  needsGross: boolean
}

type Terms = Pick<IncomeRule, 'basis' | 'percent' | 'fixedAmount'>

/**
 * Runs `rules` (already matched and in priority order) over a deposit. A percent rounds to
 * the cent; no rule gets more than is left of the deposit, and what is left after the last
 * one stays in Ready to Assign.
 */
export function incomeRuleShares<R extends Terms>(
  rules: readonly R[],
  deposit: Deposit,
): RuleShare<R>[] {
  let left = Math.max(deposit.net, 0)
  return rules.map((rule) => {
    let amount = 0
    let needsGross = false
    if (rule.percent !== null) {
      const base = rule.basis === 'gross' ? deposit.gross : deposit.net
      if (base === null) needsGross = true
      else if (base > 0) amount = percentOf(cents(base), rule.percent).amount
    } else if (rule.fixedAmount !== null) {
      amount = rule.fixedAmount
    }
    amount = Math.min(amount, left)
    left -= amount
    return { rule, amount, needsGross }
  })
}

/** The deposit after `reversed` cents were taken back; gross shrinks in the same proportion. */
export function reduceDeposit(deposit: Deposit, reversed: number): Deposit {
  const net = Math.max(deposit.net - reversed, 0)
  if (deposit.gross === null || deposit.net <= 0) return { net, gross: deposit.gross }
  return { net, gross: Math.floor((deposit.gross * net) / deposit.net) }
}

/** Does a deposit in `accountId` with this `payee` fall under the rule? */
export function ruleMatches(
  rule: Pick<IncomeRule, 'match' | 'accountId'>,
  deposit: { accountId: string; payee: string | null },
): boolean {
  if (rule.match === null && rule.accountId === null) return false
  if (rule.accountId !== null && rule.accountId !== deposit.accountId) return false
  if (rule.match === null) return true
  const needle = squashPayee(rule.match)
  return needle !== '' && ` ${squashPayee(deposit.payee)} `.includes(` ${needle} `)
}

/** Rules that can run now: one valid amount, and a target that still takes money. */
async function loadRunnableRules(db: SqlRunner): Promise<IncomeRule[]> {
  const rows = await db.query<RuleRow & Record<string, never>>(
    `SELECT ${RULE_COLUMNS} FROM income_rules r
       JOIN categories c ON c.id = r.category_id
       LEFT JOIN goals g ON g.id = r.goal_id
     WHERE c.hidden = 0 AND c.credit_card_account_id IS NULL
       AND (r.goal_id IS NULL OR (g.id IS NOT NULL AND g.archived = 0 AND g.category_id = r.category_id))
       AND ((r.percent IS NULL) <> (r.fixed_amount IS NULL))
       AND (r.match IS NOT NULL OR r.account_id IS NOT NULL)
     ${BY_PRIORITY}`,
  )
  return rows.map(toRule)
}

interface DepositRow {
  id: string
  account_id: string
  date: string
  payee: string | null
  gross_amount: number | null
  /** Sum of the uncategorized inflow lines. */
  income: number
}

/**
 * An approved, uncategorized inflow in a budget account that is not a transfer: money that
 * lands in Ready to Assign. Null for anything else, including a transaction that is gone.
 */
async function loadDeposit(db: SqlRunner, id: string): Promise<DepositRow | null> {
  const [row] = await db.query<DepositRow & Record<string, never>>(
    `SELECT t.id, t.account_id, t.date, t.payee, t.gross_amount,
       (SELECT COALESCE(SUM(s.amount), 0) FROM transaction_splits s
         WHERE s.transaction_id = t.id AND s.category_id IS NULL AND s.amount > 0) AS income
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ? AND t.approved = 1 AND t.transfer_pair_id IS NULL AND a.on_budget = 1
       AND t.payee IS NOT ?`,
    [id, ADJUSTMENT_PAYEE],
  )
  return row && row.income > 0 ? row : null
}

/** Outflows that take back a deposit, oldest first, in positive cents. */
async function loadReversals(db: SqlRunner, id: string) {
  const rows = await db.query<{ date: string; amount: number }>(
    `SELECT date, -amount AS amount FROM transactions
     WHERE reverses_id = ? AND amount < 0 AND approved = 1 ORDER BY date, id`,
    [id],
  )
  return rows.map((r) => ({ month: r.date.slice(0, 7), amount: r.amount }))
}

const keyOf = (ruleId: string, month: string, categoryId: string, goalId: string | null) =>
  [ruleId, month, categoryId, goalId ?? ''].join('|')

interface Slot {
  ruleId: string
  month: string
  categoryId: string
  goalId: string | null
  amount: number
}

/** What the rules say the ledger should hold for one deposit, per rule, month and target. */
async function wanted(db: SqlRunner, deposit: DepositRow, rules: readonly IncomeRule[]) {
  const matched = rules.filter((r) =>
    ruleMatches(r, { accountId: deposit.account_id, payee: deposit.payee }),
  )
  const slots = new Map<string, Slot>()
  const add = (rule: IncomeRule, month: string, amount: number) => {
    if (amount === 0) return
    const key = keyOf(rule.id, month, rule.categoryId, rule.goalId)
    const slot = slots.get(key) ?? {
      ruleId: rule.id,
      month,
      categoryId: rule.categoryId,
      goalId: rule.goalId,
      amount: 0,
    }
    slot.amount += amount
    slots.set(key, slot)
  }
  const full: Deposit = { net: deposit.income, gross: deposit.gross_amount }
  let before = incomeRuleShares(matched, full)
  for (const s of before) add(s.rule, deposit.date.slice(0, 7), s.amount)
  // A reversal takes its share back in the month it happens, so a month already budgeted
  // keeps what it was given.
  let reversed = 0
  for (const r of await loadReversals(db, deposit.id)) {
    reversed += r.amount
    const after = incomeRuleShares(matched, reduceDeposit(full, reversed))
    after.forEach((s, i) => add(s.rule, r.month, s.amount - before[i]!.amount))
    before = after
  }
  return { slots, matched, reversed, final: before }
}

/**
 * Brings the ledger in line with the rules for the given transactions: the allocations each
 * deposit's rules call for are added, and a deposit that was deleted, changed or reversed has
 * its allocations reversed by new entries (the ledger is append-only). Ids are built from the
 * transaction, rule and month, so two devices settling the same state write the same rows.
 * Allocations of a rule that has since been deleted or can no longer run are left alone, except
 * when the deposit itself is gone. Returns how many entries it added.
 */
export async function settleIncome(
  tx: SqlRunner,
  changes: ChangeLog,
  at: string,
  transactionIds: Iterable<string | null | undefined>,
): Promise<number> {
  const ids = [...new Set([...transactionIds].filter((id): id is string => !!id))]
  if (ids.length === 0) return 0
  const rules = await loadRunnableRules(tx)
  const names = new Map(rules.map((r) => [r.id, r.name]))
  let added = 0
  for (const id of ids) {
    const deposit = await loadDeposit(tx, id)
    const want = deposit ? (await wanted(tx, deposit, rules)).slots : new Map<string, Slot>()
    const have = await tx.query<{
      income_rule_id: string
      month: string
      category_id: string
      goal_id: string | null
      amount: number
    }>(
      `SELECT income_rule_id, month, category_id, goal_id, SUM(amount) AS amount FROM allocations
       WHERE source_transaction_id = ? AND source = 'rule' AND income_rule_id IS NOT NULL
       GROUP BY income_rule_id, month, category_id, goal_id`,
      [id],
    )
    const sequence = new Map<string, number>()
    for (const row of await tx.query<{ income_rule_id: string; month: string; n: number }>(
      `SELECT income_rule_id, month, COUNT(*) AS n FROM allocations
       WHERE source_transaction_id = ? AND income_rule_id IS NOT NULL GROUP BY income_rule_id, month`,
      [id],
    )) {
      sequence.set(`${row.income_rule_id}|${row.month}`, row.n)
    }
    const slots = new Map<string, Slot>()
    for (const [key, slot] of want) slots.set(key, { ...slot })
    for (const row of have) {
      // While the deposit stands, only rules that can still run are kept up to date.
      if (deposit && !names.has(row.income_rule_id)) continue
      const key = keyOf(row.income_rule_id, row.month, row.category_id, row.goal_id)
      const slot = slots.get(key) ?? {
        ruleId: row.income_rule_id,
        month: row.month,
        categoryId: row.category_id,
        goalId: row.goal_id,
        amount: 0,
      }
      slot.amount -= row.amount
      slots.set(key, slot)
    }
    // `slots` holds wanted - held, once the held amounts were taken off above. A wanted slot
    // with no held amount keeps its full value.
    for (const key of [...slots.keys()].sort()) {
      const slot = slots.get(key)!
      if (slot.amount === 0) continue
      const seq = `${slot.ruleId}|${slot.month}`
      const n = sequence.get(seq) ?? 0
      sequence.set(seq, n + 1)
      const name = names.get(slot.ruleId) ?? 'Income rule'
      await changes.insert('allocations', {
        id: `rule:${id}:${slot.ruleId}:${slot.month}:${n}`,
        month: slot.month,
        category_id: slot.categoryId,
        goal_id: slot.goalId,
        amount: slot.amount,
        source: 'rule',
        note: slot.amount > 0 ? name : `${name} (reversed)`,
        source_transaction_id: id,
        income_rule_id: slot.ruleId,
        created_at: at,
      })
      added++
    }
  }
  return added
}

/** Approved income dated in `month`, oldest first. */
async function depositIdsIn(db: SqlRunner, month: string): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE substr(t.date, 1, 7) = ? AND t.approved = 1 AND t.transfer_pair_id IS NULL
       AND a.on_budget = 1 AND t.amount > 0
     ORDER BY t.date, t.created_at, t.id`,
    [month],
  )
  return rows.map((r) => r.id)
}

export function incomeRulesApi({ adapter, newId, now, changes: log }: CrudDeps): IncomeRulesApi {
  async function get(db: SqlRunner, id: string): Promise<IncomeRule> {
    const [row] = await db.query<RuleRow & Record<string, never>>(
      `SELECT ${RULE_COLUMNS} FROM income_rules r WHERE r.id = ?`,
      [id],
    )
    if (!row) throw new Error('Rule not found')
    return toRule(row)
  }

  /** Checks a whole rule and returns the cleaned values to store. */
  async function clean(db: SqlRunner, input: NewIncomeRule, current: IncomeRule | null) {
    const name = cleanName(input.name, 'Rule')
    const match = input.match?.trim() || null
    if (match !== null && squashPayee(match) === '') {
      throw new Error('The payee text needs letters or numbers')
    }
    const accountId = input.accountId || null
    if (accountId !== null) {
      const [account] = await db.query<{ on_budget: number }>(
        'SELECT on_budget FROM accounts WHERE id = ?',
        [accountId],
      )
      if (!account) throw new Error('Account not found')
      if (account.on_budget !== 1) throw new Error('Income lands in a budget account')
    }
    if (match === null && accountId === null) {
      throw new Error('A rule needs a payee, an account, or both')
    }
    const basis = input.basis ?? 'net'
    if (!INCOME_BASES.includes(basis)) throw new Error('Basis must be net or gross')
    const percent = input.percent ?? null
    const fixedAmount = input.fixedAmount ?? null
    if ((percent === null) === (fixedAmount === null)) {
      throw new Error('Give either a percent or a fixed amount')
    }
    if (percent !== null) {
      const thousandths = percent * 1000
      if (
        !(percent > 0 && percent <= 100) ||
        Math.abs(thousandths - Math.round(thousandths)) > 1e-6
      ) {
        throw new Error('Percent must be above 0 and at most 100, with up to three decimals')
      }
    }
    if (fixedAmount !== null && !(Number.isSafeInteger(fixedAmount) && fixedAmount > 0)) {
      throw new Error('Fixed amount must be a positive whole number of cents')
    }
    const categoryId = input.categoryId
    const [category] = await db.query<{ credit_card_account_id: string | null }>(
      'SELECT credit_card_account_id FROM categories WHERE id = ?',
      [categoryId],
    )
    if (!category) throw new Error('Category not found')
    if (category.credit_card_account_id) {
      throw new Error('A credit card payment category can’t be given money by a rule')
    }
    const goalId = input.goalId || null
    // A rule already pointing at a goal that has since been archived can still be edited.
    if (goalId && goalId !== current?.goalId) await assertGoalUsable(db, goalId, categoryId)
    let priority = input.priority
    if (priority === undefined) {
      const [top] = await db.query<{ p: number | null }>(
        'SELECT MAX(priority) AS p FROM income_rules',
      )
      priority = (top?.p ?? 0) + 1
    }
    if (!Number.isSafeInteger(priority)) throw new Error('Priority must be a whole number')
    return {
      name,
      match,
      account_id: accountId,
      basis,
      percent,
      fixed_amount: fixedAmount,
      category_id: categoryId,
      goal_id: goalId,
      priority,
    }
  }

  return {
    async listIncomeRules() {
      const rows = await adapter.query<RuleRow & Record<string, never>>(
        `SELECT ${RULE_COLUMNS} FROM income_rules r ${BY_PRIORITY}`,
      )
      return rows.map(toRule)
    },

    async createIncomeRule(input) {
      return adapter.transaction(async (tx) => {
        const row = await clean(tx, input, null)
        const id = newId()
        await log(tx).insert('income_rules', { id, ...row, created_at: now() })
        return get(tx, id)
      })
    },

    async updateIncomeRule(id, changes) {
      return adapter.transaction(async (tx) => {
        const current = await get(tx, id)
        const row = await clean(
          tx,
          {
            name: current.name,
            match: current.match,
            accountId: current.accountId,
            basis: current.basis,
            percent: current.percent,
            fixedAmount: current.fixedAmount,
            categoryId: current.categoryId,
            goalId: current.goalId,
            priority: current.priority,
            ...changes,
          },
          current,
        )
        await log(tx).update('income_rules', id, row)
        return get(tx, id)
      })
    },

    async deleteIncomeRule(id) {
      await adapter.transaction(async (tx) => {
        await get(tx, id)
        await log(tx).delete('income_rules', id)
      })
    },

    async applyIncomeRules(month) {
      assertMonth(month)
      return adapter.transaction(async (tx) => {
        const ids = await depositIdsIn(tx, month)
        const allocations = await settleIncome(tx, log(tx), now(), ids)
        return { deposits: ids.length, allocations }
      })
    },

    async getIncomeRulesReport(month) {
      assertMonth(month)
      return adapter.transaction(async (tx) => {
        const rules = await loadRunnableRules(tx)
        const held = await tx.query<{
          income_rule_id: string
          source_transaction_id: string
          amount: number
        }>(
          `SELECT income_rule_id, source_transaction_id, SUM(amount) AS amount FROM allocations
           WHERE source = 'rule' AND source_transaction_id IS NOT NULL
           GROUP BY income_rule_id, source_transaction_id`,
        )
        const heldBy = new Map(
          held.map((h) => [`${h.source_transaction_id}|${h.income_rule_id}`, h.amount]),
        )
        const deposits: IncomeReportDeposit[] = []
        const targets = new Map<string, IncomeReportTarget>()
        const target = (categoryId: string, goalId: string | null) => {
          const key = `${categoryId}|${goalId ?? ''}`
          const found = targets.get(key) ?? {
            categoryId,
            goalId,
            expected: 0,
            fromRules: 0,
            assigned: 0,
          }
          targets.set(key, found)
          return found
        }
        for (const id of await depositIdsIn(tx, month)) {
          const row = await loadDeposit(tx, id)
          if (!row) continue
          const { matched, reversed, final } = await wanted(tx, row, rules)
          const lines = final.map<IncomeReportLine>((s) => ({
            ruleId: s.rule.id,
            ruleName: s.rule.name,
            categoryId: s.rule.categoryId,
            goalId: s.rule.goalId,
            expected: s.amount,
            assigned: heldBy.get(`${id}|${s.rule.id}`) ?? 0,
            needsGross: s.needsGross,
          }))
          for (const line of lines) {
            target(line.categoryId, line.goalId).expected += line.expected
          }
          deposits.push({
            transactionId: id,
            accountId: row.account_id,
            date: row.date,
            payee: row.payee,
            amount: row.income,
            reversed,
            gross: row.gross_amount,
            lines,
            remainder:
              Math.max(row.income - reversed, 0) - lines.reduce((sum, l) => sum + l.expected, 0),
            settled:
              matched.length === lines.length && lines.every((l) => l.assigned === l.expected),
          })
        }
        for (const rule of rules) target(rule.categoryId, rule.goalId)
        for (const t of targets.values()) {
          const [assigned] = await tx.query<{ all: number; rules: number }>(
            `SELECT COALESCE(SUM(amount), 0) AS "all",
               COALESCE(SUM(CASE WHEN source = 'rule' THEN amount END), 0) AS rules
             FROM allocations WHERE month = ? AND category_id = ? AND goal_id IS ?`,
            [month, t.categoryId, t.goalId],
          )
          t.assigned = assigned?.all ?? 0
          t.fromRules = assigned?.rules ?? 0
        }
        return { month, deposits, targets: [...targets.values()] }
      })
    },
  }
}
