import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { migrate, MIGRATIONS } from './migrations.ts'
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
  const group = await api.createCategoryGroup({ name: 'Bills' })
  const food = await api.createCategory({ groupId: group.id, name: 'Food' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  const visa = await api.createAccount({ name: 'Visa', type: 'credit' })
  const paymentCategory = async () => {
    const groups = await api.listCategoryGroups()
    return groups.flatMap((g) => g.categories).find((c) => c.creditCardAccountId === visa.id)!
  }
  const balanceOf = async (month: string, id: string) =>
    (await api.getMonthBalances(month)).find((b) => b.categoryId === id)!
  return { api, adapter, food, checking, visa, paymentCategory, balanceOf }
}

describe('credit card payment categories', () => {
  it('creates one per budget credit card, in a Credit Card Payments group', async () => {
    const { api, visa, paymentCategory } = await makeApi()
    const cat = await paymentCategory()
    expect(cat).toMatchObject({ name: 'Visa', creditCardAccountId: visa.id })
    const groups = await api.listCategoryGroups()
    expect(groups.find((g) => g.id === cat.groupId)?.name).toBe('Credit Card Payments')
    await api.createAccount({ name: 'Amex', type: 'credit' })
    await api.createAccount({ name: 'Tracked card', type: 'credit', onBudget: false })
    const payments = (await api.listCategoryGroups()).find((g) => g.id === cat.groupId)!
    expect(payments.categories.map((c) => c.name)).toEqual(['Visa', 'Amex'])
  })

  it('moves a purchase from its category into the card’s category', async () => {
    const { api, visa, food, paymentCategory, balanceOf } = await makeApi()
    const pay = await paymentCategory()
    await api.allocate({ month: '2026-01', categoryId: food.id, amount: 20000 })
    await api.createTransaction({
      accountId: visa.id,
      date: '2026-01-05',
      categoryId: food.id,
      amount: -7500,
    })
    expect(await balanceOf('2026-01', food.id)).toMatchObject({ activity: -7500, available: 12500 })
    expect(await balanceOf('2026-01', pay.id)).toMatchObject({ activity: 7500, available: 7500 })
  })

  it('draws the card’s category down when a payment is made', async () => {
    const { api, visa, checking, food, paymentCategory, balanceOf } = await makeApi()
    const pay = await paymentCategory()
    await api.createTransaction({ accountId: checking.id, date: '2026-01-01', amount: 100000 })
    await api.allocate({ month: '2026-01', categoryId: food.id, amount: 20000 })
    await api.createTransaction({
      accountId: visa.id,
      date: '2026-01-05',
      categoryId: food.id,
      amount: -7500,
    })
    await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: visa.id,
      date: '2026-01-20',
      amount: 5000,
    })
    expect(await balanceOf('2026-01', pay.id)).toMatchObject({ activity: 2500, available: 2500 })
    // paying the card moves no money in or out of the budget
    expect(await api.getReadyToAssign('2026-01')).toBe(80000)
  })

  it('carries the balance owed into later months', async () => {
    const { api, visa, checking, food, paymentCategory, balanceOf } = await makeApi()
    const pay = await paymentCategory()
    await api.allocate({ month: '2026-01', categoryId: food.id, amount: 10000 })
    await api.createTransaction({
      accountId: visa.id,
      date: '2026-01-05',
      categoryId: food.id,
      amount: -4000,
    })
    expect(await balanceOf('2026-02', pay.id)).toMatchObject({ activity: 0, available: 4000 })
    await api.createTransaction({ accountId: checking.id, date: '2026-02-01', amount: 50000 })
    await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: visa.id,
      date: '2026-02-10',
      amount: 4000,
    })
    expect(await balanceOf('2026-02', pay.id)).toMatchObject({ activity: -4000, available: 0 })
  })

  it('takes a refund back out of the card’s category', async () => {
    const { api, visa, food, paymentCategory, balanceOf } = await makeApi()
    const pay = await paymentCategory()
    await api.allocate({ month: '2026-01', categoryId: food.id, amount: 10000 })
    await api.createTransaction({
      accountId: visa.id,
      date: '2026-01-05',
      categoryId: food.id,
      amount: -4000,
    })
    await api.createTransaction({
      accountId: visa.id,
      date: '2026-01-08',
      categoryId: food.id,
      amount: 1000,
    })
    expect(await balanceOf('2026-01', pay.id)).toMatchObject({ available: 3000 })
  })

  it('treats paying more than was set aside as overspending the payment category', async () => {
    const { api, visa, checking, food, paymentCategory, balanceOf } = await makeApi()
    const pay = await paymentCategory()
    await api.createTransaction({ accountId: checking.id, date: '2026-01-01', amount: 100000 })
    await api.allocate({ month: '2026-01', categoryId: food.id, amount: 10000 })
    await api.createTransaction({
      accountId: visa.id,
      date: '2026-01-05',
      categoryId: food.id,
      amount: -4000,
    })
    await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: visa.id,
      date: '2026-01-20',
      amount: 6000,
    })
    expect((await balanceOf('2026-01', pay.id)).available).toBe(-2000)
    // January's shortfall comes out of February's Ready to Assign, like any cash overspending
    expect(await api.getReadyToAssign('2026-02')).toBe(100000 - 10000 - 2000)
  })

  it('lets the user budget extra into the payment category', async () => {
    const { api, paymentCategory, checking, balanceOf } = await makeApi()
    const pay = await paymentCategory()
    await api.createTransaction({ accountId: checking.id, date: '2026-01-01', amount: 100000 })
    await api.allocate({ month: '2026-01', categoryId: pay.id, amount: 15000 })
    expect(await balanceOf('2026-01', pay.id)).toMatchObject({ assigned: 15000, available: 15000 })
  })

  it('keeps payment categories managed by the app', async () => {
    const { api, food, visa, paymentCategory } = await makeApi()
    const pay = await paymentCategory()
    await expect(api.updateCategory(pay.id, { name: 'Other' })).rejects.toThrow(/follows its card/)
    await expect(api.updateCategory(pay.id, { groupId: food.groupId })).rejects.toThrow(
      /follows its card/,
    )
    await expect(api.deleteCategory(pay.id)).rejects.toThrow(/goes with its card/)
    expect((await api.updateCategory(pay.id, { hidden: true })).hidden).toBe(true)
    await expect(
      api.createTransaction({
        accountId: visa.id,
        date: '2026-01-05',
        categoryId: pay.id,
        amount: -100,
      }),
    ).rejects.toThrow(/payment category/)
  })

  it('follows the card when it is renamed, leaves the budget or is deleted', async () => {
    const { api, visa, paymentCategory } = await makeApi()
    await api.updateAccount(visa.id, { name: 'Visa Signature' })
    expect((await paymentCategory()).name).toBe('Visa Signature')
    await api.updateAccount(visa.id, { onBudget: false })
    expect((await paymentCategory()).hidden).toBe(true)
    await api.updateAccount(visa.id, { onBudget: true })
    expect((await paymentCategory()).hidden).toBe(false)
    await api.deleteAccount(visa.id)
    const all = (await api.listCategoryGroups()).flatMap((g) => g.categories)
    expect(all.some((c) => c.creditCardAccountId)).toBe(false)
  })

  it('a routine edit does not unhide a category the user hid', async () => {
    const { api, visa, paymentCategory } = await makeApi()
    const pay = await paymentCategory()
    await api.updateCategory(pay.id, { hidden: true })
    await api.updateAccount(visa.id, { closed: true })
    expect((await paymentCategory()).hidden).toBe(true)
  })

  it('migration gives cards that already exist their payment category', async () => {
    const adapter = await openMemoryAdapter({ migrated: false })
    await migrate(adapter, { migrations: MIGRATIONS.filter((m) => m.version <= 5) })
    await adapter.exec(
      `INSERT INTO accounts (id, name, type, on_budget, created_at) VALUES
         ('a1', 'Visa', 'credit', 1, 'x'), ('a2', 'Old card', 'credit', 0, 'x'), ('a3', 'Checking', 'checking', 1, 'x')`,
    )
    await migrate(adapter)
    const rows = await adapter.query(
      'SELECT id, group_id, name, credit_card_account_id FROM categories',
    )
    expect(rows).toEqual([
      {
        id: 'payment-a1',
        group_id: 'credit-card-payments',
        name: 'Visa',
        credit_card_account_id: 'a1',
      },
    ])
  })
})
