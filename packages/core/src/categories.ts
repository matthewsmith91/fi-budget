import { assertSameIds, cleanName, flag, type CrudDeps } from './crud.ts'
import type { ChangeLog } from './changes.ts'
import type { SqlRunner } from './storage.ts'

export const NEED_OR_WANT = ['need', 'want'] as const
export type NeedOrWant = (typeof NEED_OR_WANT)[number]

export interface Category {
  id: string
  groupId: string
  name: string
  needOrWant: NeedOrWant
  hidden: boolean
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
  /** Changing `groupId` moves the category to the end of that group. */
  updateCategory(
    id: string,
    changes: { name?: string; needOrWant?: NeedOrWant; hidden?: boolean; groupId?: string },
  ): Promise<Category>
  deleteCategory(id: string): Promise<void>
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
  credit_card_account_id: string | null
}

const toCategory = (r: CategoryRow): Category => ({
  id: r.id,
  groupId: r.group_id,
  name: r.name,
  needOrWant: r.need_or_want,
  hidden: r.hidden === 1,
  creditCardAccountId: r.credit_card_account_id,
})

const CATEGORY_SELECT =
  'SELECT id, group_id, name, need_or_want, hidden, credit_card_account_id FROM categories'

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

function assertNeedOrWant(value: string) {
  if (!NEED_OR_WANT.includes(value as NeedOrWant)) throw new Error(`Unknown tag "${value}"`)
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
        await log(tx).update('categories', id, {
          group_id: groupId,
          name,
          need_or_want: patch.needOrWant ?? current.needOrWant,
          hidden: flag(patch.hidden ?? current.hidden),
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
        const [used] = await tx.query(
          `SELECT 1 AS x FROM allocations WHERE category_id = ?
           UNION ALL SELECT 1 FROM transaction_splits WHERE category_id = ? LIMIT 1`,
          [id, id],
        )
        if (used) throw new Error('This category has budget history; hide it instead of deleting')
        const changes = log(tx)
        const rules = await tx.query<{ id: string }>(
          'SELECT id FROM payee_rules WHERE category_id = ?',
          [id],
        )
        for (const rule of rules) await changes.delete('payee_rules', rule.id)
        await changes.delete('categories', id)
      })
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
