import { cleanName, type CrudDeps } from './crud.ts'
import { loadTransactions } from './transactions.ts'
import type { SqlRunner } from './storage.ts'

export interface PayeeRule {
  id: string
  /** Text a payee must contain, as whole words, ignoring case and punctuation. */
  match: string
  categoryId: string
  createdAt: string
}

export interface PayeeRulesApi {
  /** Oldest first. */
  listPayeeRules(): Promise<PayeeRule[]>
  /** Payees containing `match` as whole words are put in `categoryId` when they are imported. */
  createPayeeRule(input: { match: string; categoryId: string }): Promise<PayeeRule>
  updatePayeeRule(id: string, changes: { match?: string; categoryId?: string }): Promise<PayeeRule>
  deletePayeeRule(id: string): Promise<void>
  /**
   * Gives the rules' category to every transaction waiting in the inbox that has none yet.
   * Returns how many it changed. Nothing is approved; a person still looks at each one.
   */
  applyPayeeRules(): Promise<number>
}

interface RuleRow {
  id: string
  match: string
  category_id: string
  created_at: string
}

const toRule = (r: RuleRow): PayeeRule => ({
  id: r.id,
  match: r.match,
  categoryId: r.category_id,
  createdAt: r.created_at,
})

/** Lower case words separated by single spaces, so "AMAZON.COM*AB12" and "Amazon" compare. */
export const squashPayee = (s: string | null) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** The rule that applies to a payee: the most specific (longest) match, the oldest on a tie. */
export function matchPayeeRule<R extends { match: string }>(
  rules: readonly R[],
  payee: string | null,
): R | null {
  const haystack = ` ${squashPayee(payee)} `
  let best: { rule: R; length: number } | null = null
  for (const rule of rules) {
    const needle = squashPayee(rule.match)
    if (!needle || !haystack.includes(` ${needle} `)) continue
    // `rules` arrives oldest first, so a strictly longer match is needed to displace one
    if (!best || needle.length > best.length) best = { rule, length: needle.length }
  }
  return best?.rule ?? null
}

/** Rules whose category can still be used: it exists, is not hidden and is not a card's. */
export async function loadUsableRules(db: SqlRunner): Promise<PayeeRule[]> {
  const rows = await db.query<RuleRow & Record<string, never>>(
    `SELECT r.id, r.match, r.category_id, r.created_at FROM payee_rules r
     JOIN categories c ON c.id = r.category_id
     WHERE c.hidden = 0 AND c.credit_card_account_id IS NULL
     ORDER BY r.created_at, r.id`,
  )
  return rows.map(toRule)
}

export function payeeRulesApi({ adapter, newId, now, changes: log }: CrudDeps): PayeeRulesApi {
  async function assertCategory(db: SqlRunner, id: string) {
    const [row] = await db.query<{ credit_card_account_id: string | null }>(
      'SELECT credit_card_account_id FROM categories WHERE id = ?',
      [id],
    )
    if (!row) throw new Error('Category not found')
    if (row.credit_card_account_id) {
      throw new Error('A credit card payment category can’t be used on a transaction')
    }
  }

  async function cleanMatch(db: SqlRunner, input: string, exceptId: string) {
    const match = cleanName(input, 'Payee')
    const squashed = squashPayee(match)
    if (!squashed) throw new Error('The payee text needs letters or numbers')
    const rows = await db.query<RuleRow & Record<string, never>>(
      'SELECT id, match, category_id, created_at FROM payee_rules WHERE id <> ?',
      [exceptId],
    )
    if (rows.some((r) => squashPayee(r.match) === squashed)) {
      throw new Error(`There is already a rule for “${match}”`)
    }
    return match
  }

  async function get(db: SqlRunner, id: string): Promise<PayeeRule> {
    const [row] = await db.query<RuleRow & Record<string, never>>(
      'SELECT id, match, category_id, created_at FROM payee_rules WHERE id = ?',
      [id],
    )
    if (!row) throw new Error('Rule not found')
    return toRule(row)
  }

  return {
    async listPayeeRules() {
      const rows = await adapter.query<RuleRow & Record<string, never>>(
        'SELECT id, match, category_id, created_at FROM payee_rules ORDER BY created_at, id',
      )
      return rows.map(toRule)
    },

    async createPayeeRule({ match, categoryId }) {
      return adapter.transaction(async (tx) => {
        const clean = await cleanMatch(tx, match, '')
        await assertCategory(tx, categoryId)
        const id = newId()
        await log(tx).insert('payee_rules', {
          id,
          match: clean,
          category_id: categoryId,
          created_at: now(),
        })
        return get(tx, id)
      })
    },

    async updatePayeeRule(id, changes) {
      return adapter.transaction(async (tx) => {
        const current = await get(tx, id)
        const match =
          changes.match === undefined ? current.match : await cleanMatch(tx, changes.match, id)
        const categoryId = changes.categoryId ?? current.categoryId
        if (categoryId !== current.categoryId) await assertCategory(tx, categoryId)
        await log(tx).update('payee_rules', id, { match, category_id: categoryId })
        return get(tx, id)
      })
    },

    async deletePayeeRule(id) {
      await adapter.transaction(async (tx) => {
        await get(tx, id)
        await log(tx).delete('payee_rules', id)
      })
    },

    async applyPayeeRules() {
      return adapter.transaction(async (tx) => {
        const rules = await loadUsableRules(tx)
        if (rules.length === 0) return 0
        const changes = log(tx)
        let changed = 0
        for (const t of await loadTransactions(tx, 'WHERE t.approved = 0', [])) {
          const [only, ...rest] = t.splits
          if (!only || rest.length > 0 || only.categoryId !== null) continue
          if (t.transferPairId !== null) continue
          const [account] = await tx.query<{ on_budget: number }>(
            'SELECT on_budget FROM accounts WHERE id = ?',
            [t.accountId],
          )
          if (account?.on_budget !== 1) continue
          const rule = matchPayeeRule(rules, t.payee)
          if (!rule) continue
          await changes.update('transaction_splits', only.id, { category_id: rule.categoryId })
          changed++
        }
        return changed
      })
    },
  }
}
