import { ACCOUNT_TYPES, type AccountType } from './accounts.ts'
import { allocationsApi } from './allocations.ts'
import { ensurePaymentCategory } from './categories.ts'
import type { CrudDeps } from './crud.ts'
import { flag } from './crud.ts'
import type { SqlRunner } from './storage.ts'
import {
  parseBudget,
  parseRegister,
  planRegister,
  type BudgetRow,
  type DateOrder,
  type Plan,
  type RegisterRow,
} from './ynab-parse.ts'

/** The two files of YNAB's "Export Budget Data". */
export interface YnabFiles {
  /** Register.csv: every transaction. */
  register: string
  /** Budget.csv: what was assigned to each category each month. */
  budget?: string
  /** Override when the register's date format is ambiguous (see `ambiguousDates` in the preview). */
  dateOrder?: DateOrder
}

export interface YnabAccountPreview {
  name: string
  transactions: number
  /** The account's balance after every transaction in the file. */
  balance: number
  first: string
  last: string
  /** An account here with the same name, the likely target. */
  match: { accountId: string; closed: boolean; hasTransactions: boolean } | null
}

export interface YnabPreview {
  dateOrder: DateOrder
  ambiguousDates: boolean
  accounts: YnabAccountPreview[]
  transactions: number
  splitTransactions: number
  transfers: number
  /** Distinct categories used, and how many of those are not in this budget yet. */
  categories: number
  newCategories: number
  /** Month-by-category assignments in Budget.csv worth importing. */
  allocations: number
  months: number
  first: string | null
  last: string | null
  /** Things that will not come across exactly. */
  warnings: string[]
}

export type YnabAccountChoice =
  { accountId: string } | { create: { type: AccountType; onBudget: boolean } }

export interface YnabImportInput extends YnabFiles {
  /** For each account in the file, by its YNAB name: where its transactions go. */
  accounts: Record<string, YnabAccountChoice>
}

export interface YnabMismatch {
  month: string
  category: string
  field: 'available' | 'activity'
  ynab: number
  ours: number
}

export interface YnabImportResult {
  accountsCreated: number
  /** Ordinary and split transactions; a transfer counts once, under `transfers`. */
  transactions: number
  splitTransactions: number
  transfers: number
  groupsCreated: number
  categoriesCreated: number
  allocations: number
  warnings: string[]
  /** Where this budget's numbers differ from YNAB's own Budget.csv, first 100. */
  mismatches: YnabMismatch[]
  mismatchCount: number
}

export interface YnabApi {
  /** Reads the files and says what importing them would do, without changing anything. */
  previewYnabImport(files: YnabFiles): Promise<YnabPreview>
  /**
   * Brings YNAB's history in: accounts (made or matched), categories, every transaction with
   * its splits and transfers, and each month's assignments. All or nothing, and only once:
   * a budget that already holds an import refuses another.
   */
  importYnab(input: YnabImportInput): Promise<YnabImportResult>
}

const HIDDEN_GROUP = 'hidden categories'
const NOTE = 'Imported from YNAB'
const PREFIX = 'ynab-'
const MISMATCH_LIMIT = 100

const key = (group: string, category: string) => `${group.toLowerCase()}\0${category.toLowerCase()}`

function warningsFor(plan: Plan, hasBudget: boolean): string[] {
  const out = ['Memos are not imported: this app has no memo field yet.']
  if (plan.skippedZero > 0) {
    out.push(
      `${plan.skippedZero} line${plan.skippedZero === 1 ? '' : 's'} with no amount will be skipped.`,
    )
  }
  if (plan.unpairedTransfers > 0) {
    out.push(
      `${plan.unpairedTransfers} transfer${plan.unpairedTransfers === 1 ? ' has' : 's have'} no matching other side in the file and will come in as ordinary transactions.`,
    )
  }
  if (plan.brokenSplits > 0) {
    out.push(
      `${plan.brokenSplits} split line${plan.brokenSplits === 1 ? ' is' : 's are'} missing the rest of their transaction and will come in as separate transactions.`,
    )
  }
  if (!hasBudget) {
    out.push(
      'Without Budget.csv no monthly assignments are imported, so Ready to Assign starts as all your income.',
    )
  }
  return out
}

function allRows(plan: Plan): RegisterRow[] {
  return plan.items.flatMap((i) =>
    i.kind === 'transaction' ? [i.row] : i.kind === 'split' ? i.parts : [i.first, i.second],
  )
}

export function ynabApi(deps: CrudDeps): YnabApi {
  const { adapter, newId, now, changes: log } = deps

  return {
    async previewYnabImport(files) {
      const register = parseRegister(files.register, files.dateOrder)
      const plan = planRegister(register.rows)
      const budget = files.budget ? parseBudget(files.budget) : []
      const rows = allRows(plan)

      const existing = await adapter.query<{ id: string; name: string; closed: number; n: number }>(
        `SELECT a.id, a.name, a.closed,
           (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS n FROM accounts a`,
      )
      const byName = new Map(existing.map((a) => [a.name.toLowerCase(), a]))
      const accounts = new Map<string, YnabAccountPreview>()
      // A split counts once; its lines still all add to the balance.
      const counted = plan.items.flatMap((i) =>
        i.kind === 'transaction'
          ? [{ row: i.row, counts: true }]
          : i.kind === 'split'
            ? i.parts.map((row, n) => ({ row, counts: n === 0 }))
            : [i.first, i.second].map((row) => ({ row, counts: true })),
      )
      for (const { row: r, counts } of counted) {
        const found = accounts.get(r.account) ?? {
          name: r.account,
          transactions: 0,
          balance: 0,
          first: r.date,
          last: r.date,
          match: null,
        }
        if (counts) found.transactions++
        found.balance += r.amount
        if (r.date < found.first) found.first = r.date
        if (r.date > found.last) found.last = r.date
        const match = byName.get(r.account.toLowerCase())
        found.match = match
          ? { accountId: match.id, closed: match.closed === 1, hasTransactions: match.n > 0 }
          : null
        accounts.set(r.account, found)
      }

      const known = new Set(
        (
          await adapter.query<{ g: string; c: string }>(
            'SELECT g.name AS g, c.name AS c FROM categories c JOIN category_groups g ON g.id = c.group_id',
          )
        ).map((r) => key(r.g, r.c)),
      )
      const used = new Set(
        [...rows, ...budget.filter((b) => b.budgeted !== 0)].flatMap((r) => {
          const group = 'group' in r ? r.group : null
          const category = 'category' in r ? r.category : null
          return group && category ? [key(group, category)] : []
        }),
      )
      const dates = rows.map((r) => r.date).toSorted()
      const assigned = budget.filter((b) => b.budgeted !== 0)
      return {
        dateOrder: register.dateOrder,
        ambiguousDates: register.ambiguousDates,
        accounts: [...accounts.values()],
        transactions: plan.items.filter((i) => i.kind !== 'transfer').length,
        splitTransactions: plan.items.filter((i) => i.kind === 'split').length,
        transfers: plan.items.filter((i) => i.kind === 'transfer').length,
        categories: used.size,
        newCategories: [...used].filter((k) => !known.has(k)).length,
        allocations: assigned.length,
        months: new Set(assigned.map((b) => b.month)).size,
        first: dates[0] ?? null,
        last: dates.at(-1) ?? null,
        warnings: [...register.warnings, ...warningsFor(plan, files.budget !== undefined)],
      }
    },

    async importYnab(input) {
      const register = parseRegister(input.register, input.dateOrder)
      const plan = planRegister(register.rows)
      const budget = input.budget ? parseBudget(input.budget) : []
      const rows = allRows(plan)
      if (rows.length === 0) throw new Error('The register has no transactions to import')

      const result = await adapter.transaction(async (tx) => {
        const [done] = await tx.query('SELECT 1 AS x FROM transactions WHERE id LIKE ? LIMIT 1', [
          `${PREFIX}%`,
        ])
        if (done) throw new Error('YNAB history has already been imported into this budget')
        const changes = log(tx)
        const at = now()
        const out: YnabImportResult = {
          accountsCreated: 0,
          transactions: 0,
          splitTransactions: 0,
          transfers: 0,
          groupsCreated: 0,
          categoriesCreated: 0,
          allocations: 0,
          warnings: warningsFor(plan, input.budget !== undefined),
          mismatches: [],
          mismatchCount: 0,
        }

        // Accounts: every account in the file needs a destination.
        const accounts = new Map<string, { id: string; onBudget: boolean }>()
        const taken = new Set(
          (await tx.query<{ name: string }>('SELECT name FROM accounts')).map((a) =>
            a.name.toLowerCase(),
          ),
        )
        for (const name of new Set(rows.map((r) => r.account))) {
          const choice = input.accounts[name]
          if (!choice) throw new Error(`Choose where the YNAB account “${name}” goes`)
          if ('accountId' in choice) {
            const [existing] = await tx.query<{ closed: number; on_budget: number }>(
              'SELECT closed, on_budget FROM accounts WHERE id = ?',
              [choice.accountId],
            )
            if (!existing) throw new Error(`The account chosen for “${name}” no longer exists`)
            if (existing.closed === 1) throw new Error(`The account chosen for “${name}” is closed`)
            accounts.set(name, { id: choice.accountId, onBudget: existing.on_budget === 1 })
            continue
          }
          const { type, onBudget } = choice.create
          if (!ACCOUNT_TYPES.includes(type)) throw new Error(`Unknown account type “${type}”`)
          if (type === 'investment' && onBudget) {
            throw new Error('Investment accounts are tracking accounts and cannot be on budget')
          }
          if (taken.has(name.toLowerCase())) {
            throw new Error(
              `An account named “${name}” already exists; pick it instead of creating one`,
            )
          }
          taken.add(name.toLowerCase())
          const id = newId()
          await changes.insert('accounts', {
            id,
            name,
            type,
            on_budget: flag(onBudget),
            closed: 0,
            created_at: at,
          })
          if (type === 'credit' && onBudget) {
            await ensurePaymentCategory(tx, changes, { id, name }, at)
          }
          accounts.set(name, { id, onBudget })
          out.accountsCreated++
        }
        const taking = new Set<string>()
        for (const { id } of accounts.values()) {
          if (taking.has(id))
            throw new Error('Two YNAB accounts cannot go to the same account here')
          taking.add(id)
        }

        // Categories: matched by group and name, made when missing.
        const resolver = await categoryResolver(tx, changes, newId, at, out)
        const categoryFor = (r: RegisterRow, onBudget: boolean) =>
          onBudget && r.group && r.category
            ? resolver.ensure(r.group, r.category)
            : Promise.resolve(null)

        const insertTransaction = async (
          id: string,
          r: RegisterRow,
          accountId: string,
          fields: { payee: string | null; pairId?: string },
          lines: { id: string; categoryId: string | null; amount: number }[],
        ) => {
          await changes.insert('transactions', {
            id,
            account_id: accountId,
            date: r.date,
            payee: fields.payee,
            amount: lines.reduce((sum, l) => sum + l.amount, 0),
            cleared: flag(r.cleared !== 'uncleared'),
            reconciled: flag(r.cleared === 'reconciled'),
            ...(fields.pairId && { transfer_pair_id: fields.pairId }),
            created_at: at,
          })
          for (const line of lines) {
            await changes.insert('transaction_splits', {
              id: line.id,
              transaction_id: id,
              category_id: line.categoryId,
              amount: line.amount,
              created_at: at,
            })
          }
        }

        for (const item of plan.items) {
          if (item.kind === 'transaction') {
            const r = item.row
            const account = accounts.get(r.account)!
            const id = `${PREFIX}r${r.n}`
            await insertTransaction(id, r, account.id, { payee: r.payee || null }, [
              {
                id: `${id}:s1`,
                categoryId: await categoryFor(r, account.onBudget),
                amount: r.amount,
              },
            ])
            out.transactions++
          } else if (item.kind === 'split') {
            const [head] = item.parts
            const account = accounts.get(head!.account)!
            const id = `${PREFIX}r${head!.n}`
            const lines = []
            for (const [i, part] of item.parts.entries()) {
              lines.push({
                id: `${id}:s${i + 1}`,
                categoryId: await categoryFor(part, account.onBudget),
                amount: part.amount,
              })
            }
            await insertTransaction(id, head!, account.id, { payee: head!.payee || null }, lines)
            out.transactions++
            out.splitTransactions++
          } else {
            const pairId = `${PREFIX}p${item.first.n}`
            const legs = [item.first, item.second].map((r) => ({
              r,
              account: accounts.get(r.account)!,
            }))
            const crossesEdge = legs[0]!.account.onBudget !== legs[1]!.account.onBudget
            for (const { r, account } of legs) {
              const id = `${PREFIX}r${r.n}`
              // Only the budget side of a budget-to-tracking transfer can carry a category.
              const categoryId = crossesEdge ? await categoryFor(r, account.onBudget) : null
              await insertTransaction(id, r, account.id, { payee: null, pairId }, [
                { id: `${id}:s1`, categoryId, amount: r.amount },
              ])
            }
            out.transfers++
          }
        }

        // Assignments from Budget.csv.
        const months = new Set<string>()
        for (const b of budget) {
          if (b.budgeted === 0) continue
          const categoryId = await resolver.ensure(b.group, b.category)
          await changes.insert('allocations', {
            id: `${PREFIX}a-${b.month}-${categoryId}`,
            month: b.month,
            category_id: categoryId,
            goal_id: null,
            amount: b.budgeted,
            source: 'manual',
            note: NOTE,
            created_at: at,
          })
          months.add(b.month)
          out.allocations++
        }
        return { out, months: [...months], resolver }
      })

      // Check our numbers against YNAB's own, month by month. Differences are reported, not hidden.
      const { out, resolver } = result
      const allocations = allocationsApi(deps)
      const byMonth = new Map<string, BudgetRow[]>()
      for (const b of budget) byMonth.set(b.month, [...(byMonth.get(b.month) ?? []), b])
      for (const [month, lines] of byMonth) {
        const balances = new Map(
          (await allocations.getMonthBalances(month)).map((b) => [b.categoryId, b]),
        )
        for (const line of lines) {
          const id = resolver.find(line.group, line.category)
          const ours = id ? balances.get(id) : undefined
          if (!ours) continue
          for (const field of ['available', 'activity'] as const) {
            if (ours[field] === line[field]) continue
            out.mismatchCount++
            if (out.mismatches.length < MISMATCH_LIMIT) {
              out.mismatches.push({
                month,
                category: `${line.group}: ${line.category}`,
                field,
                ynab: line[field],
                ours: ours[field],
              })
            }
          }
        }
      }
      return out
    },
  }
}

/** Finds or makes the app's category for a YNAB group and category name. */
async function categoryResolver(
  tx: SqlRunner,
  changes: ReturnType<CrudDeps['changes']>,
  newId: () => string,
  at: string,
  out: Pick<YnabImportResult, 'groupsCreated' | 'categoriesCreated'>,
) {
  const groups = new Map<string, string>()
  const categories = new Map<string, string>()
  const nextSort = new Map<string, number>()
  let nextGroupSort = 0

  for (const g of await tx.query<{ id: string; name: string; sort: number }>(
    'SELECT id, name, sort FROM category_groups',
  )) {
    groups.set(g.name.toLowerCase(), g.id)
    nextGroupSort = Math.max(nextGroupSort, g.sort + 1)
  }
  for (const c of await tx.query<{
    id: string
    name: string
    group_id: string
    sort: number
    group: string
  }>(
    `SELECT c.id, c.name, c.group_id, c.sort, g.name AS "group"
     FROM categories c JOIN category_groups g ON g.id = c.group_id`,
  )) {
    categories.set(key(c.group, c.name), c.id)
    nextSort.set(c.group_id, Math.max(nextSort.get(c.group_id) ?? 0, c.sort + 1))
  }

  return {
    find(group: string, category: string): string | undefined {
      return categories.get(key(group, category))
    },
    async ensure(group: string, category: string): Promise<string> {
      const existing = categories.get(key(group, category))
      if (existing) return existing
      let groupId = groups.get(group.toLowerCase())
      if (!groupId) {
        groupId = newId()
        await changes.insert('category_groups', {
          id: groupId,
          name: group,
          sort: nextGroupSort++,
          hidden: flag(group.toLowerCase() === HIDDEN_GROUP),
          created_at: at,
        })
        groups.set(group.toLowerCase(), groupId)
        out.groupsCreated++
      }
      const id = newId()
      const sort = nextSort.get(groupId) ?? 0
      nextSort.set(groupId, sort + 1)
      await changes.insert('categories', {
        id,
        group_id: groupId,
        name: category,
        need_or_want: 'want',
        sort,
        hidden: flag(group.toLowerCase() === HIDDEN_GROUP),
        created_at: at,
      })
      categories.set(key(group, category), id)
      out.categoriesCreated++
      return id
    },
  }
}

export type { BudgetRow }
