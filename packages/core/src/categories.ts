import { assertMonth, monthBalances, type Month } from './allocations.ts'
import { assertSameIds, cleanName, flag, type CrudDeps } from './crud.ts'
import type { ChangeLog } from './changes.ts'
import { clearEducationLinks } from './education.ts'
import { goalFigures } from './goals.ts'
import { cents, formatCents } from './money.ts'
import { clearRecurringLinks } from './recurring.ts'
import type { SqlRunner } from './storage.ts'

export const NEED_OR_WANT = ['need', 'want'] as const
export type NeedOrWant = (typeof NEED_OR_WANT)[number]

/** What a category does once paychecks stop. */
export const RETIREMENT_STATUSES = ['continues', 'ends', 'changes'] as const
export type RetirementStatus = (typeof RETIREMENT_STATUSES)[number]

/** A 'changes' category's multiplier is a positive number up to this. */
export const MAX_RETIREMENT_MULTIPLIER = 10

export interface Category {
  id: string
  groupId: string
  name: string
  needOrWant: NeedOrWant
  hidden: boolean
  /** Whether the spending continues, ends or changes in retirement. */
  retirementStatus: RetirementStatus
  /**
   * What spending is multiplied by in retirement (travel ×1.5). Set only while the status is
   * `changes`, null otherwise.
   */
  retirementMultiplier: number | null
  /**
   * Set on a credit card's payment category: the card whose purchases fund it and whose
   * payments draw it down. The app manages these; they can't be renamed, moved or deleted.
   */
  creditCardAccountId: string | null
}

export interface CategoryGroup {
  id: string
  name: string
  hidden: boolean
  /** In display order. */
  categories: Category[]
}

export interface CategoryRemoval {
  /** `deleted` when it was never used, `hidden` when it has history to keep. */
  outcome: 'deleted' | 'hidden'
  /** Cents handed back to Ready to Assign (always 0 when deleted). */
  returned: number
  /** Goals that are deleted with it or archived. */
  goals: number
  /** Payee and income rules that are deleted with it. */
  rules: number
  /** Whether it is the household's emergency fund. */
  emergencyFund: boolean
  /** Why it can't be removed, or null. */
  blocked: string | null
}

export interface CategoriesApi {
  /** Every group in display order, each with its categories. Hidden ones are included. */
  listCategoryGroups(): Promise<CategoryGroup[]>
  createCategoryGroup(input: { name: string }): Promise<CategoryGroup>
  updateCategoryGroup(
    id: string,
    changes: { name?: string; hidden?: boolean },
  ): Promise<CategoryGroup>
  /** Only an empty group can be deleted; hide it to keep its categories' history. */
  deleteCategoryGroup(id: string): Promise<void>
  reorderCategoryGroups(ids: string[]): Promise<void>

  createCategory(input: {
    groupId: string
    name: string
    needOrWant?: NeedOrWant
  }): Promise<Category>
  /**
   * Changing `groupId` moves the category to the end of that group. `retirementStatus`
   * `changes` needs a `retirementMultiplier`; any other status clears it. A credit card's
   * payment category isn't spending, so it has no retirement status.
   */
  updateCategory(
    id: string,
    changes: {
      name?: string
      needOrWant?: NeedOrWant
      hidden?: boolean
      groupId?: string
      retirementStatus?: RetirementStatus
      retirementMultiplier?: number | null
    },
  ): Promise<Category>
  deleteCategory(id: string): Promise<void>
  /** What `removeCategory` would do, without doing it; `blocked` says why it can't. */
  planCategoryRemoval(id: string, input: { month: Month }): Promise<CategoryRemoval>
  /**
   * Takes a category out of the budget. One that was never used is deleted; one with history is
   * hidden so old transactions keep their category, after its money (and its goals', which are
   * archived) goes back to Ready to Assign in `month`. Its payee and income rules are deleted,
   * and it stops being the emergency fund. A card's payment category and an overspent one are
   * refused.
   */
  removeCategory(id: string, input: { month: Month }): Promise<CategoryRemoval>
  reorderCategories(groupId: string, ids: string[]): Promise<void>
}

interface GroupRow {
  id: string
  name: string
  hidden: number
}

interface CategoryRow {
  id: string
  group_id: string
  name: string
  need_or_want: NeedOrWant
  hidden: number
  retirement_status: RetirementStatus
  retirement_multiplier: number | null
  credit_card_account_id: string | null
}

const toCategory = (r: CategoryRow): Category => ({
  id: r.id,
  groupId: r.group_id,
  name: r.name,
  needOrWant: r.need_or_want,
  hidden: r.hidden === 1,
  retirementStatus: r.retirement_status,
  // a 'changes' category whose multiplier hasn't synced yet reads as x1
  retirementMultiplier: r.retirement_status === 'changes' ? (r.retirement_multiplier ?? 1) : null,
  creditCardAccountId: r.credit_card_account_id,
})

const CATEGORY_SELECT = `SELECT id, group_id, name, need_or_want, hidden, retirement_status,
  retirement_multiplier, credit_card_account_id FROM categories`

async function categoriesIn(db: SqlRunner, groupId: string): Promise<Category[]> {
  const rows = await db.query<CategoryRow & Record<string, never>>(
    `${CATEGORY_SELECT} WHERE group_id = ? ORDER BY sort, created_at, id`,
    [groupId],
  )
  return rows.map(toCategory)
}

async function getGroup(db: SqlRunner, id: string): Promise<CategoryGroup> {
  const [row] = await db.query<GroupRow & Record<string, never>>(
    'SELECT id, name, hidden FROM category_groups WHERE id = ?',
    [id],
  )
  if (!row) throw new Error('Category group not found')
  return {
    id: row.id,
    name: row.name,
    hidden: row.hidden === 1,
    categories: await categoriesIn(db, id),
  }
}

async function getCategory(db: SqlRunner, id: string): Promise<Category> {
  const [row] = await db.query<CategoryRow & Record<string, never>>(
    `${CATEGORY_SELECT} WHERE id = ?`,
    [id],
  )
  if (!row) throw new Error('Category not found')
  return toCategory(row)
}

async function nextSort(db: SqlRunner, table: 'category_groups' | 'categories', groupId?: string) {
  const [row] =
    table === 'categories'
      ? await db.query<{ n: number }>(
          'SELECT COALESCE(MAX(sort) + 1, 0) AS n FROM categories WHERE group_id = ?',
          [groupId!],
        )
      : await db.query<{ n: number }>('SELECT COALESCE(MAX(sort) + 1, 0) AS n FROM category_groups')
  return row!.n
}

async function assertGroupNameFree(db: SqlRunner, name: string, exceptId?: string) {
  const [dup] = await db.query(
    'SELECT 1 AS x FROM category_groups WHERE name = ? COLLATE NOCASE AND id <> ?',
    [name, exceptId ?? ''],
  )
  if (dup) throw new Error(`A category group named "${name}" already exists`)
}

async function assertCategoryNameFree(
  db: SqlRunner,
  groupId: string,
  name: string,
  exceptId?: string,
) {
  const [dup] = await db.query(
    'SELECT 1 AS x FROM categories WHERE group_id = ? AND name = ? COLLATE NOCASE AND id <> ?',
    [groupId, name, exceptId ?? ''],
  )
  if (dup) throw new Error(`This group already has a category named "${name}"`)
}

export function assertNeedOrWant(value: string) {
  if (!NEED_OR_WANT.includes(value as NeedOrWant)) throw new Error(`Unknown tag "${value}"`)
}

/** The status and multiplier to store: only `changes` keeps a multiplier. */
function retirementFields(
  status: RetirementStatus,
  multiplier: number | null | undefined,
): { retirement_status: RetirementStatus; retirement_multiplier: number | null } {
  if (!RETIREMENT_STATUSES.includes(status))
    throw new Error(`Unknown retirement status "${status}"`)
  if (status !== 'changes') return { retirement_status: status, retirement_multiplier: null }
  if (multiplier == null) throw new Error('Enter what spending is multiplied by in retirement')
  const rounded = Math.round(multiplier * 100) / 100
  if (!Number.isFinite(rounded) || rounded <= 0 || rounded > MAX_RETIREMENT_MULTIPLIER) {
    throw new Error(`The multiplier must be more than 0 and at most ${MAX_RETIREMENT_MULTIPLIER}`)
  }
  return { retirement_status: status, retirement_multiplier: rounded }
}

export const PAYMENT_GROUP_ID = 'credit-card-payments'
export const paymentCategoryId = (accountId: string) => `payment-${accountId}`

/**
 * Gives a budget credit card its payment category (and the group that holds them), under
 * deterministic ids so two devices that add a card offline end up with one row each.
 * Brings a hidden one back when `unhide` is set.
 */
export async function ensurePaymentCategory(
  tx: SqlRunner,
  changes: ChangeLog,
  account: { id: string; name: string },
  at: string,
  /** Show the category again if it was hidden; leave a hidden one alone otherwise. */
  unhide = true,
): Promise<void> {
  const [group] = await tx.query('SELECT 1 AS x FROM category_groups WHERE id = ?', [
    PAYMENT_GROUP_ID,
  ])
  if (!group) {
    await changes.insert('category_groups', {
      id: PAYMENT_GROUP_ID,
      name: 'Credit Card Payments',
      sort: await nextSort(tx, 'category_groups'),
      hidden: 0,
      created_at: at,
    })
  }
  const id = paymentCategoryId(account.id)
  const [existing] = await tx.query('SELECT 1 AS x FROM categories WHERE id = ?', [id])
  if (existing) {
    await changes.update('categories', id, {
      name: account.name,
      ...(unhide && { hidden: 0 }),
    })
    return
  }
  await changes.insert('categories', {
    id,
    group_id: PAYMENT_GROUP_ID,
    name: account.name,
    need_or_want: 'need',
    sort: await nextSort(tx, 'categories', PAYMENT_GROUP_ID),
    hidden: 0,
    credit_card_account_id: account.id,
    created_at: at,
  })
}

export const RESERVES_GROUP_ID = 'reserves'
export const EMERGENCY_FUND_CATEGORY_ID = 'emergency-fund'

/**
 * Gives the emergency fund its category in the Reserves group, under deterministic ids so two
 * devices that create it offline end up with one row each. Brings back a hidden group or
 * category (a fund that was deleted and is being made again) and reuses a group or category the
 * household already named the same.
 */
export async function ensureEmergencyFundCategory(
  tx: SqlRunner,
  changes: ChangeLog,
  at: string,
): Promise<string> {
  let [group] = await tx.query<{ id: string; hidden: number }>(
    `SELECT id, hidden FROM category_groups
     WHERE id = ? OR name = 'Reserves' COLLATE NOCASE ORDER BY id = ? DESC, created_at, id LIMIT 1`,
    [RESERVES_GROUP_ID, RESERVES_GROUP_ID],
  )
  if (!group) {
    await changes.insert('category_groups', {
      id: RESERVES_GROUP_ID,
      name: 'Reserves',
      sort: await nextSort(tx, 'category_groups'),
      hidden: 0,
      created_at: at,
    })
    group = { id: RESERVES_GROUP_ID, hidden: 0 }
  } else if (group.hidden === 1) {
    await changes.update('category_groups', group.id, { hidden: 0 })
  }
  const [existing] = await tx.query<{ id: string; hidden: number }>(
    `SELECT id, hidden FROM categories
     WHERE id = ? OR (group_id = ? AND name = 'Emergency Fund' COLLATE NOCASE)
     ORDER BY id = ? DESC, created_at, id LIMIT 1`,
    [EMERGENCY_FUND_CATEGORY_ID, group.id, EMERGENCY_FUND_CATEGORY_ID],
  )
  if (existing) {
    if (existing.hidden === 1) await changes.update('categories', existing.id, { hidden: 0 })
    return existing.id
  }
  await changes.insert('categories', {
    id: EMERGENCY_FUND_CATEGORY_ID,
    group_id: group.id,
    name: 'Emergency Fund',
    need_or_want: 'need',
    sort: await nextSort(tx, 'categories', group.id),
    hidden: 0,
    created_at: at,
  })
  return EMERGENCY_FUND_CATEGORY_ID
}

/**
 * After the emergency fund is removed: the Reserves group that held it goes too if nothing
 * visible is left in it (deleted when empty, hidden when old transactions still use a category).
 */
export async function tidyReservesGroup(tx: SqlRunner, changes: ChangeLog): Promise<void> {
  const [group] = await tx.query('SELECT 1 AS x FROM category_groups WHERE id = ?', [
    RESERVES_GROUP_ID,
  ])
  if (!group) return
  const [visible] = await tx.query(
    'SELECT 1 AS x FROM categories WHERE group_id = ? AND hidden = 0 LIMIT 1',
    [RESERVES_GROUP_ID],
  )
  if (visible) return
  const [any] = await tx.query('SELECT 1 AS x FROM categories WHERE group_id = ? LIMIT 1', [
    RESERVES_GROUP_ID,
  ])
  if (any) await changes.update('category_groups', RESERVES_GROUP_ID, { hidden: 1 })
  else await changes.delete('category_groups', RESERVES_GROUP_ID)
}

/** Hides a card's payment category, e.g. once the account leaves the budget. */
export async function hidePaymentCategory(
  tx: SqlRunner,
  changes: ChangeLog,
  accountId: string,
): Promise<void> {
  const id = paymentCategoryId(accountId)
  const [existing] = await tx.query('SELECT 1 AS x FROM categories WHERE id = ?', [id])
  if (existing) await changes.update('categories', id, { hidden: 1 })
}

/** Whether anything was ever assigned to or spent from a category. */
async function hasHistory(db: SqlRunner, id: string): Promise<boolean> {
  const [used] = await db.query(
    `SELECT 1 AS x FROM allocations WHERE category_id = ?
     UNION ALL SELECT 1 FROM transaction_splits WHERE category_id = ? LIMIT 1`,
    [id, id],
  )
  return !!used
}

/** Drops what only makes sense while the category is in use: its rules and links to it. */
async function detach(db: SqlRunner, changes: ChangeLog, id: string): Promise<void> {
  for (const table of ['payee_rules', 'income_rules']) {
    const rules = await db.query<{ id: string }>(`SELECT id FROM ${table} WHERE category_id = ?`, [
      id,
    ])
    for (const rule of rules) await changes.delete(table, rule.id)
  }
  await clearRecurringLinks(db, changes, { categoryId: id })
  // The household's emergency fund can't point at a category that is gone.
  const funds = await db.query<{ id: string }>(
    'SELECT id FROM households WHERE emergency_fund_category_id = ?',
    [id],
  )
  for (const h of funds) {
    await changes.update('households', h.id, { emergency_fund_category_id: null })
  }
}

/** Deletes a category with no budget history, and its goals (which have none either). */
async function deleteUnused(db: SqlRunner, changes: ChangeLog, id: string): Promise<void> {
  await detach(db, changes, id)
  const goals = await db.query<{ id: string }>('SELECT id FROM goals WHERE category_id = ?', [id])
  for (const goal of goals) {
    await clearEducationLinks(db, changes, { goalId: goal.id })
    await changes.delete('goals', goal.id)
  }
  await changes.delete('categories', id)
}

async function planRemoval(db: SqlRunner, id: string, month: Month) {
  assertMonth(month)
  const category = await getCategory(db, id)
  const used = await hasHistory(db, id)
  const count = async (table: string) =>
    (
      await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE category_id = ?`, [
        id,
      ])
    )[0]!.n
  const rules = (await count('payee_rules')) + (await count('income_rules'))
  const allGoals = await db.query<{ id: string; archived: number }>(
    'SELECT id, archived FROM goals WHERE category_id = ?',
    [id],
  )
  const figures = await goalFigures(db, month)
  const goals = allGoals
    .filter((g) => g.archived === 0)
    .map((g) => ({ id: g.id, held: figures.get(g.id)?.available ?? 0 }))
  const available =
    (await monthBalances(db, month)).find((b) => b.categoryId === id)?.available ?? 0
  const [fund] = await db.query(
    'SELECT 1 AS x FROM households WHERE emergency_fund_category_id = ?',
    [id],
  )
  let blocked: string | null = null
  if (category.creditCardAccountId) {
    blocked = 'A credit card payment category goes with its card; hide it instead'
  } else if (used && available < 0) {
    blocked = `${category.name} is overspent by ${formatCents(cents(-available))}. Cover that from another category first.`
  }
  const summary: CategoryRemoval = {
    outcome: used ? 'hidden' : 'deleted',
    returned: used ? Math.max(available, 0) : 0,
    goals: used ? goals.length : allGoals.length,
    rules,
    emergencyFund: !!fund,
    blocked,
  }
  return { summary, category, available, goals }
}

/** `removeCategory` inside a transaction the caller already holds. */
export async function removeCategoryIn(
  tx: SqlRunner,
  deps: Pick<CrudDeps, 'newId' | 'now' | 'changes'>,
  id: string,
  month: Month,
): Promise<CategoryRemoval> {
  const { summary, category, available, goals } = await planRemoval(tx, id, month)
  if (summary.blocked) throw new Error(summary.blocked)
  const changes = deps.changes(tx)
  if (summary.outcome === 'deleted') {
    await deleteUnused(tx, changes, id)
    return summary
  }
  // Hand the money back: each goal's balance, then what the category itself holds.
  const note = `Removed category “${category.name}”`
  const at = deps.now()
  const give = (goalId: string | null, amount: number) =>
    changes.insert('allocations', {
      id: deps.newId(),
      month,
      category_id: id,
      goal_id: goalId,
      amount: -amount,
      source: 'move',
      note,
      created_at: at,
    })
  let inGoals = 0
  for (const goal of goals) {
    if (goal.held !== 0) await give(goal.id, goal.held)
    inGoals += goal.held
    await changes.update('goals', goal.id, { archived: 1 })
  }
  if (available - inGoals !== 0) await give(null, available - inGoals)
  await detach(tx, changes, id)
  await changes.update('categories', id, { hidden: 1 })
  return summary
}

export function categoriesApi({ adapter, newId, now, changes: log }: CrudDeps): CategoriesApi {
  return {
    async listCategoryGroups() {
      return adapter.transaction(async (tx) => {
        const groups = await tx.query<GroupRow & Record<string, never>>(
          'SELECT id, name, hidden FROM category_groups ORDER BY sort, created_at, id',
        )
        const categories = (
          await tx.query<CategoryRow & Record<string, never>>(
            `${CATEGORY_SELECT} ORDER BY sort, created_at, id`,
          )
        ).map(toCategory)
        return groups.map((g) => ({
          id: g.id,
          name: g.name,
          hidden: g.hidden === 1,
          categories: categories.filter((c) => c.groupId === g.id),
        }))
      })
    },
    async createCategoryGroup({ name }) {
      const clean = cleanName(name, 'Category group')
      return adapter.transaction(async (tx) => {
        await assertGroupNameFree(tx, clean)
        const id = newId()
        await log(tx).insert('category_groups', {
          id,
          name: clean,
          sort: await nextSort(tx, 'category_groups'),
          hidden: 0,
          created_at: now(),
        })
        return getGroup(tx, id)
      })
    },
    async updateCategoryGroup(id, patch) {
      return adapter.transaction(async (tx) => {
        const current = await getGroup(tx, id)
        const name =
          patch.name === undefined ? current.name : cleanName(patch.name, 'Category group')
        if (name !== current.name) await assertGroupNameFree(tx, name, id)
        await log(tx).update('category_groups', id, {
          name,
          hidden: flag(patch.hidden ?? current.hidden),
        })
        return getGroup(tx, id)
      })
    },
    async deleteCategoryGroup(id) {
      await adapter.transaction(async (tx) => {
        const group = await getGroup(tx, id)
        if (group.categories.length > 0) {
          throw new Error('Move or delete this group’s categories first, or hide the group')
        }
        await log(tx).delete('category_groups', id)
      })
    },
    async reorderCategoryGroups(ids) {
      await adapter.transaction(async (tx) => {
        const existing = await tx.query<{ id: string }>('SELECT id FROM category_groups')
        assertSameIds(
          ids,
          existing.map((r) => r.id),
          'group',
        )
        const changes = log(tx)
        for (const [i, id] of ids.entries())
          await changes.update('category_groups', id, { sort: i })
      })
    },

    async createCategory({ groupId, name, needOrWant = 'want' }) {
      const clean = cleanName(name, 'Category')
      assertNeedOrWant(needOrWant)
      return adapter.transaction(async (tx) => {
        await getGroup(tx, groupId)
        await assertCategoryNameFree(tx, groupId, clean)
        const id = newId()
        await log(tx).insert('categories', {
          id,
          group_id: groupId,
          name: clean,
          need_or_want: needOrWant,
          sort: await nextSort(tx, 'categories', groupId),
          hidden: 0,
          created_at: now(),
        })
        return getCategory(tx, id)
      })
    },
    async updateCategory(id, patch) {
      if (patch.needOrWant !== undefined) assertNeedOrWant(patch.needOrWant)
      return adapter.transaction(async (tx) => {
        const current = await getCategory(tx, id)
        if (
          current.creditCardAccountId &&
          (patch.name !== undefined || patch.groupId !== undefined)
        ) {
          throw new Error(
            'A credit card payment category follows its card; rename the account instead',
          )
        }
        const name = patch.name === undefined ? current.name : cleanName(patch.name, 'Category')
        const groupId = patch.groupId ?? current.groupId
        const moved = groupId !== current.groupId
        if (moved) await getGroup(tx, groupId)
        if (moved || name !== current.name) await assertCategoryNameFree(tx, groupId, name, id)
        const retirementPatched =
          patch.retirementStatus !== undefined || patch.retirementMultiplier !== undefined
        if (current.creditCardAccountId && retirementPatched) {
          throw new Error(
            'A credit card payment category isn’t spending, so it has no retirement status',
          )
        }
        await log(tx).update('categories', id, {
          group_id: groupId,
          name,
          need_or_want: patch.needOrWant ?? current.needOrWant,
          hidden: flag(patch.hidden ?? current.hidden),
          ...(retirementPatched &&
            retirementFields(
              patch.retirementStatus ?? current.retirementStatus,
              patch.retirementMultiplier === undefined
                ? current.retirementMultiplier
                : patch.retirementMultiplier,
            )),
          ...(moved && { sort: await nextSort(tx, 'categories', groupId) }),
        })
        return getCategory(tx, id)
      })
    },
    async deleteCategory(id) {
      await adapter.transaction(async (tx) => {
        const category = await getCategory(tx, id)
        if (category.creditCardAccountId) {
          throw new Error('A credit card payment category goes with its card; hide it instead')
        }
        if (await hasHistory(tx, id)) {
          throw new Error('This category has budget history; hide it instead of deleting')
        }
        await deleteUnused(tx, log(tx), id)
      })
    },
    async planCategoryRemoval(id, { month }) {
      return adapter.transaction(async (tx) => (await planRemoval(tx, id, month)).summary)
    },
    async removeCategory(id, { month }) {
      return adapter.transaction((tx) =>
        removeCategoryIn(tx, { newId, now, changes: log }, id, month),
      )
    },
    async reorderCategories(groupId, ids) {
      await adapter.transaction(async (tx) => {
        const existing = await categoriesIn(tx, (await getGroup(tx, groupId)).id)
        assertSameIds(
          ids,
          existing.map((c) => c.id),
          'category',
        )
        const changes = log(tx)
        for (const [i, id] of ids.entries()) await changes.update('categories', id, { sort: i })
      })
    },
  }
}

/** Removes a card's payment category with the card: deleted if unused, hidden if it has history. */
export async function dropPaymentCategory(
  tx: SqlRunner,
  changes: ChangeLog,
  accountId: string,
): Promise<void> {
  const id = paymentCategoryId(accountId)
  const [existing] = await tx.query('SELECT 1 AS x FROM categories WHERE id = ?', [id])
  if (!existing) return
  const [used] = await tx.query('SELECT 1 AS x FROM allocations WHERE category_id = ? LIMIT 1', [
    id,
  ])
  if (used) await changes.update('categories', id, { hidden: 1 })
  else await changes.delete('categories', id)
}
