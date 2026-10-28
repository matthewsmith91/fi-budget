import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { openMemoryAdapter } from './test-utils.ts'

async function makeApi() {
  const adapter = await openMemoryAdapter()
  let n = 0
  const api = createBudgetApi({
    adapter,
    storage: 'memory',
    sqliteVersion: 'test',
    newId: () => `id-${++n}`,
    now: () => '2026-01-01T00:00:00.000Z',
  })
  return { api, adapter }
}

describe('accounts', () => {
  it('creates, lists in creation order, and defaults on-budget by type', async () => {
    const { api } = await makeApi()
    expect(await api.listAccounts()).toEqual([])
    await api.createAccount({ name: ' Checking ', type: 'checking' })
    await api.createAccount({ name: 'Visa', type: 'credit' })
    await api.createAccount({ name: 'Brokerage', type: 'investment' })
    await api.createAccount({ name: 'Old HYSA', type: 'savings', onBudget: false })
    expect(await api.listAccounts()).toEqual([
      { id: 'id-1', name: 'Checking', type: 'checking', onBudget: true, closed: false },
      { id: 'id-2', name: 'Visa', type: 'credit', onBudget: true, closed: false },
      { id: 'id-3', name: 'Brokerage', type: 'investment', onBudget: false, closed: false },
      { id: 'id-4', name: 'Old HYSA', type: 'savings', onBudget: false, closed: false },
    ])
  })

  it('validates input', async () => {
    const { api } = await makeApi()
    await expect(api.createAccount({ name: '  ', type: 'checking' })).rejects.toThrow(/name/)
    await expect(api.createAccount({ name: 'X', type: 'cash' as never })).rejects.toThrow(/type/)
    await expect(
      api.createAccount({ name: 'Brokerage', type: 'investment', onBudget: true }),
    ).rejects.toThrow(/tracking/)
    await api.createAccount({ name: 'Checking', type: 'checking' })
    await expect(api.createAccount({ name: 'checking', type: 'savings' })).rejects.toThrow(
      /already exists/,
    )
  })

  it('updates name, on-budget and closed; the type is fixed', async () => {
    const { api } = await makeApi()
    const a = await api.createAccount({ name: 'Checking', type: 'checking' })
    const b = await api.createAccount({ name: 'Savings', type: 'savings' })
    expect(await api.updateAccount(a.id, { name: 'Main', closed: true })).toMatchObject({
      name: 'Main',
      closed: true,
      onBudget: true,
    })
    expect(await api.updateAccount(a.id, { closed: false, onBudget: false })).toMatchObject({
      name: 'Main',
      closed: false,
      onBudget: false,
    })
    await expect(api.updateAccount(b.id, { name: 'main' })).rejects.toThrow(/already exists/)
    // renaming to its own name with different case is fine
    expect(await api.updateAccount(b.id, { name: 'SAVINGS' })).toMatchObject({ name: 'SAVINGS' })
    const inv = await api.createAccount({ name: 'Roth', type: 'investment' })
    await expect(api.updateAccount(inv.id, { onBudget: true })).rejects.toThrow(/tracking/)
    await expect(api.updateAccount('nope', { name: 'x' })).rejects.toThrow(/not found/)
  })

  it('deletes', async () => {
    const { api } = await makeApi()
    const a = await api.createAccount({ name: 'Checking', type: 'checking' })
    await api.deleteAccount(a.id)
    expect(await api.listAccounts()).toEqual([])
    await expect(api.deleteAccount(a.id)).rejects.toThrow(/not found/)
  })
})

describe('category groups and categories', () => {
  it('creates groups and categories in order and nests them', async () => {
    const { api } = await makeApi()
    const bills = await api.createCategoryGroup({ name: 'Bills' })
    const fun = await api.createCategoryGroup({ name: 'Fun' })
    expect(bills).toEqual({ id: 'id-1', name: 'Bills', hidden: false, categories: [] })
    await api.createCategory({ groupId: bills.id, name: 'Rent', needOrWant: 'need' })
    await api.createCategory({ groupId: bills.id, name: 'Internet' })
    await api.createCategory({ groupId: fun.id, name: 'Jessica Personal' })
    const groups = await api.listCategoryGroups()
    expect(groups.map((g) => [g.name, g.categories.map((c) => c.name)])).toEqual([
      ['Bills', ['Rent', 'Internet']],
      ['Fun', ['Jessica Personal']],
    ])
    expect(groups[0]!.categories.map((c) => c.needOrWant)).toEqual(['need', 'want'])
  })

  it('validates names, tags and parents', async () => {
    const { api } = await makeApi()
    const g = await api.createCategoryGroup({ name: 'Bills' })
    const other = await api.createCategoryGroup({ name: 'Fun' })
    await expect(api.createCategoryGroup({ name: ' ' })).rejects.toThrow(/name/)
    await expect(api.createCategoryGroup({ name: 'bills' })).rejects.toThrow(/already exists/)
    await expect(api.createCategory({ groupId: 'nope', name: 'x' })).rejects.toThrow(/not found/)
    await expect(api.createCategory({ groupId: g.id, name: '' })).rejects.toThrow(/name/)
    await expect(
      api.createCategory({ groupId: g.id, name: 'x', needOrWant: 'both' as never }),
    ).rejects.toThrow(/tag/)
    await api.createCategory({ groupId: g.id, name: 'Rent' })
    await expect(api.createCategory({ groupId: g.id, name: 'RENT' })).rejects.toThrow(/already has/)
    // the same name is fine in another group
    await api.createCategory({ groupId: other.id, name: 'Rent' })
  })

  it('renames and hides groups', async () => {
    const { api } = await makeApi()
    const g = await api.createCategoryGroup({ name: 'Bills' })
    await api.createCategory({ groupId: g.id, name: 'Rent' })
    const updated = await api.updateCategoryGroup(g.id, { name: 'Fixed', hidden: true })
    expect(updated).toMatchObject({ name: 'Fixed', hidden: true })
    expect(updated.categories).toHaveLength(1)
    await expect(api.updateCategoryGroup('nope', {})).rejects.toThrow(/not found/)
  })

  it('updates a category and moves it to the end of another group', async () => {
    const { api } = await makeApi()
    const a = await api.createCategoryGroup({ name: 'A' })
    const b = await api.createCategoryGroup({ name: 'B' })
    const x = await api.createCategory({ groupId: a.id, name: 'X' })
    await api.createCategory({ groupId: b.id, name: 'Y' })
    await api.createCategory({ groupId: b.id, name: 'Z' })
    expect(
      await api.updateCategory(x.id, { name: 'X2', needOrWant: 'need', hidden: true }),
    ).toEqual({
      id: x.id,
      groupId: a.id,
      name: 'X2',
      needOrWant: 'need',
      hidden: true,
      creditCardAccountId: null,
    })
    await api.updateCategory(x.id, { groupId: b.id })
    const groups = await api.listCategoryGroups()
    expect(groups[0]!.categories).toEqual([])
    expect(groups[1]!.categories.map((c) => c.name)).toEqual(['Y', 'Z', 'X2'])

    await api.createCategory({ groupId: a.id, name: 'Y' })
    const y = groups[1]!.categories[0]!
    await expect(api.updateCategory(y.id, { groupId: a.id })).rejects.toThrow(/already has/)
    await expect(api.updateCategory(y.id, { groupId: 'nope' })).rejects.toThrow(/not found/)
  })

  it('reorders groups and categories, requiring every id exactly once', async () => {
    const { api } = await makeApi()
    const a = await api.createCategoryGroup({ name: 'A' })
    const b = await api.createCategoryGroup({ name: 'B' })
    const c1 = await api.createCategory({ groupId: a.id, name: 'C1' })
    const c2 = await api.createCategory({ groupId: a.id, name: 'C2' })
    await api.reorderCategoryGroups([b.id, a.id])
    await api.reorderCategories(a.id, [c2.id, c1.id])
    const groups = await api.listCategoryGroups()
    expect(groups.map((g) => g.name)).toEqual(['B', 'A'])
    expect(groups[1]!.categories.map((c) => c.name)).toEqual(['C2', 'C1'])

    await expect(api.reorderCategoryGroups([a.id])).rejects.toThrow(/exactly once/)
    await expect(api.reorderCategoryGroups([a.id, a.id])).rejects.toThrow(/exactly once/)
    await expect(api.reorderCategories(a.id, [c1.id, 'nope'])).rejects.toThrow(/exactly once/)
    await expect(api.reorderCategories('nope', [])).rejects.toThrow(/not found/)
  })

  it('deletes categories, and only empty groups', async () => {
    const { api } = await makeApi()
    const g = await api.createCategoryGroup({ name: 'Bills' })
    const c = await api.createCategory({ groupId: g.id, name: 'Rent' })
    await expect(api.deleteCategoryGroup(g.id)).rejects.toThrow(/categories first/)
    await api.deleteCategory(c.id)
    await expect(api.deleteCategory(c.id)).rejects.toThrow(/not found/)
    await api.deleteCategoryGroup(g.id)
    expect(await api.listCategoryGroups()).toEqual([])
  })

  it('survives a JSON export and import', async () => {
    const { api } = await makeApi()
    await api.createAccount({ name: 'Checking', type: 'checking' })
    const g = await api.createCategoryGroup({ name: 'Bills' })
    await api.createCategory({ groupId: g.id, name: 'Rent', needOrWant: 'need' })
    const json = await api.exportJson()

    const other = await makeApi()
    await other.api.importJson(json)
    expect(await other.api.listAccounts()).toHaveLength(1)
    expect((await other.api.listCategoryGroups())[0]!.categories[0]).toMatchObject({
      name: 'Rent',
      needOrWant: 'need',
    })
  })
})
