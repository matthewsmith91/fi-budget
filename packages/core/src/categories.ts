import { assertSameIds, cleanName, flag, type CrudDeps } from './crud.ts'
import type { SqlRunner } from './storage.ts'

export const NEED_OR_WANT = ['need', 'want'] as const
export type NeedOrWant = (typeof NEED_OR_WANT)[number]

export interface Category {
  id: string
  groupId: string
  name: string
  needOrWant: NeedOrWant
  hidden: boolean
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
}

const toCategory = (r: CategoryRow): Category => ({
  id: r.id,
  groupId: r.group_id,
  name: r.name,
  needOrWant: r.need_or_want,
  hidden: r.hidden === 1,
})

const CATEGORY_SELECT = 'SELECT id, group_id, name, need_or_want, hidden FROM categories'

async function categoriesIn(db: SqlRunner, groupId: string): Promise<Category[]> {
  const rows = await db.query<CategoryRow & Record<string, never>>(
    `${CATEGORY_SELECT} WHERE group_id = ? ORDER BY sort, rowid`,
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

export function categoriesApi({ adapter, newId, now }: CrudDeps): CategoriesApi {
  return {
    async listCategoryGroups() {
      return adapter.transaction(async (tx) => {
        const groups = await tx.query<GroupRow & Record<string, never>>(
          'SELECT id, name, hidden FROM category_groups ORDER BY sort, rowid',
        )
        const categories = (
          await tx.query<CategoryRow & Record<string, never>>(
            `${CATEGORY_SELECT} ORDER BY sort, rowid`,
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
        await tx.exec(
          'INSERT INTO category_groups (id, name, sort, created_at) VALUES (?, ?, ?, ?)',
          [id, clean, await nextSort(tx, 'category_groups'), now()],
        )
        return getGroup(tx, id)
      })
    },
    async updateCategoryGroup(id, changes) {
      return adapter.transaction(async (tx) => {
        const current = await getGroup(tx, id)
        const name =
          changes.name === undefined ? current.name : cleanName(changes.name, 'Category group')
        if (name !== current.name) await assertGroupNameFree(tx, name, id)
        await tx.exec('UPDATE category_groups SET name = ?, hidden = ? WHERE id = ?', [
          name,
          flag(changes.hidden ?? current.hidden),
          id,
        ])
        return getGroup(tx, id)
      })
    },
    async deleteCategoryGroup(id) {
      await adapter.transaction(async (tx) => {
        const group = await getGroup(tx, id)
        if (group.categories.length > 0) {
          throw new Error('Move or delete this group’s categories first, or hide the group')
        }
        await tx.exec('DELETE FROM category_groups WHERE id = ?', [id])
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
        for (const [i, id] of ids.entries()) {
          await tx.exec('UPDATE category_groups SET sort = ? WHERE id = ?', [i, id])
        }
      })
    },

    async createCategory({ groupId, name, needOrWant = 'want' }) {
      const clean = cleanName(name, 'Category')
      assertNeedOrWant(needOrWant)
      return adapter.transaction(async (tx) => {
        await getGroup(tx, groupId)
        await assertCategoryNameFree(tx, groupId, clean)
        const id = newId()
        await tx.exec(
          'INSERT INTO categories (id, group_id, name, need_or_want, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [id, groupId, clean, needOrWant, await nextSort(tx, 'categories', groupId), now()],
        )
        return getCategory(tx, id)
      })
    },
    async updateCategory(id, changes) {
      if (changes.needOrWant !== undefined) assertNeedOrWant(changes.needOrWant)
      return adapter.transaction(async (tx) => {
        const current = await getCategory(tx, id)
        const name = changes.name === undefined ? current.name : cleanName(changes.name, 'Category')
        const groupId = changes.groupId ?? current.groupId
        const moved = groupId !== current.groupId
        if (moved) await getGroup(tx, groupId)
        if (moved || name !== current.name) await assertCategoryNameFree(tx, groupId, name, id)
        await tx.exec(
          'UPDATE categories SET group_id = ?, name = ?, need_or_want = ?, hidden = ?, sort = ? WHERE id = ?',
          [
            groupId,
            name,
            changes.needOrWant ?? current.needOrWant,
            flag(changes.hidden ?? current.hidden),
            moved ? await nextSort(tx, 'categories', groupId) : await sortOf(tx, id),
            id,
          ],
        )
        return getCategory(tx, id)
      })
    },
    async deleteCategory(id) {
      await adapter.transaction(async (tx) => {
        await getCategory(tx, id)
        await tx.exec('DELETE FROM categories WHERE id = ?', [id])
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
        for (const [i, id] of ids.entries()) {
          await tx.exec('UPDATE categories SET sort = ? WHERE id = ?', [i, id])
        }
      })
    },
  }
}

async function sortOf(db: SqlRunner, categoryId: string): Promise<number> {
  const [row] = await db.query<{ sort: number }>('SELECT sort FROM categories WHERE id = ?', [
    categoryId,
  ])
  return row!.sort
}
