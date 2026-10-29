import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { matchPayeeRule } from './payee-rules.ts'
import { openMemoryAdapter } from './test-utils.ts'

async function makeApi() {
  const adapter = await openMemoryAdapter()
  let n = 0
  const api = createBudgetApi({
    adapter,
    storage: 'memory',
    sqliteVersion: 'test',
    newId: () => `id-${++n}`,
    now: () => '2026-10-28T00:00:00.000Z',
  })
  const group = await api.createCategoryGroup({ name: 'Bills' })
  const food = await api.createCategory({ groupId: group.id, name: 'Food' })
  const fun = await api.createCategory({ groupId: group.id, name: 'Fun' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  const brokerage = await api.createAccount({ name: 'Brokerage', type: 'investment' })
  await api.mapExternalAccount({ externalId: 'ACT-1', name: 'Chase', accountId: checking.id })
  await api.mapExternalAccount({ externalId: 'ACT-2', name: 'Fidelity', accountId: brokerage.id })
  return { api, food, fun, checking, brokerage }
}

const tx = (id: string, description: string, amount = -1000) => ({
  id,
  posted: '2026-10-20',
  amount,
  description,
})
const bank = (...transactions: ReturnType<typeof tx>[]) => [
  { id: 'ACT-1', name: 'Chase', transactions },
]
const categoryOf = (t: { splits: { categoryId: string | null }[] }) => t.splits[0]!.categoryId

describe('matchPayeeRule', () => {
  const rules = [
    { id: 'a', match: 'Amazon' },
    { id: 'b', match: 'Amazon Prime' },
    { id: 'c', match: 'uber' },
  ]

  it('matches whole words, ignoring case and punctuation', () => {
    expect(matchPayeeRule(rules, 'AMAZON.COM*AB12')?.id).toBe('a')
    expect(matchPayeeRule(rules, 'costco amazon')?.id).toBe('a')
    expect(matchPayeeRule(rules, 'Suburban Propane')).toBeNull()
    expect(matchPayeeRule(rules, 'UBER *TRIP')?.id).toBe('c')
    expect(matchPayeeRule(rules, null)).toBeNull()
  })

  it('prefers the more specific rule, and the older one on a tie', () => {
    expect(matchPayeeRule(rules, 'AMAZON PRIME VIDEO')?.id).toBe('b')
    const tied = [
      { id: 'x', match: 'shell' },
      { id: 'y', match: 'SHELL' },
    ]
    expect(matchPayeeRule(tied, 'Shell Oil')?.id).toBe('x')
  })
})

describe('payee rules', () => {
  it('creates, edits and deletes a rule', async () => {
    const { api, food, fun } = await makeApi()
    const rule = await api.createPayeeRule({ match: '  Kroger ', categoryId: food.id })
    expect(rule).toMatchObject({ match: 'Kroger', categoryId: food.id })
    expect(await api.listPayeeRules()).toEqual([rule])

    const edited = await api.updatePayeeRule(rule.id, { match: 'Kroger Fuel', categoryId: fun.id })
    expect(edited).toMatchObject({ match: 'Kroger Fuel', categoryId: fun.id })
    await api.deletePayeeRule(rule.id)
    expect(await api.listPayeeRules()).toEqual([])
  })

  it('refuses a duplicate, an empty match and an unknown or card payment category', async () => {
    const { api, food } = await makeApi()
    await api.createPayeeRule({ match: 'Kroger', categoryId: food.id })
    await expect(api.createPayeeRule({ match: 'KROGER!', categoryId: food.id })).rejects.toThrow(
      /already a rule/,
    )
    await expect(api.createPayeeRule({ match: '  ', categoryId: food.id })).rejects.toThrow(
      /required/,
    )
    await expect(api.createPayeeRule({ match: '***', categoryId: food.id })).rejects.toThrow(
      /letters or numbers/,
    )
    await expect(api.createPayeeRule({ match: 'Shell', categoryId: 'nope' })).rejects.toThrow(
      /Category not found/,
    )
    const card = await api.createAccount({ name: 'Visa', type: 'credit' })
    await expect(
      api.createPayeeRule({ match: 'Shell', categoryId: `payment-${card.id}` }),
    ).rejects.toThrow(/payment category/)
  })

  it('goes with its category when that is deleted', async () => {
    const { api, food } = await makeApi()
    await api.createPayeeRule({ match: 'Kroger', categoryId: food.id })
    await api.deleteCategory(food.id)
    expect(await api.listPayeeRules()).toEqual([])
  })
})

describe('rules at import', () => {
  it('categorizes a new bank transaction but leaves it in the inbox', async () => {
    const { api, food } = await makeApi()
    await api.createPayeeRule({ match: 'kroger', categoryId: food.id })
    const summary = await api.importTransactions(bank(tx('T1', 'KROGER #123'), tx('T2', 'MYSTERY')))
    expect(summary.added).toBe(2)
    const inbox = await api.listInbox()
    expect(inbox.map((i) => [i.transaction.payee, categoryOf(i.transaction)])).toEqual([
      ['KROGER #123', food.id],
      ['MYSTERY', null],
    ])
    expect(inbox.every((i) => !i.transaction.approved)).toBe(true)
  })

  it('does not categorize into a hidden category', async () => {
    const { api, food } = await makeApi()
    await api.createPayeeRule({ match: 'kroger', categoryId: food.id })
    await api.updateCategory(food.id, { hidden: true })
    await api.importTransactions(bank(tx('T1', 'KROGER')))
    expect(categoryOf((await api.listInbox())[0]!.transaction)).toBeNull()
  })

  it('leaves tracking accounts uncategorized', async () => {
    const { api, food } = await makeApi()
    await api.createPayeeRule({ match: 'dividend', categoryId: food.id })
    await api.importTransactions([
      { id: 'ACT-2', name: 'Fidelity', transactions: [tx('D1', 'DIVIDEND', 500)] },
    ])
    expect(categoryOf((await api.listInbox())[0]!.transaction)).toBeNull()
  })
})

describe('applying rules to the inbox', () => {
  it('fills in uncategorized inbox transactions only', async () => {
    const { api, food, fun } = await makeApi()
    await api.importTransactions(bank(tx('T1', 'KROGER'), tx('T2', 'KROGER FUEL'), tx('T3', 'ZOO')))
    const [, second] = (await api.listInbox()).toReversed()
    await api.updateTransaction(second!.transaction.id, { categoryId: fun.id })
    await api.createPayeeRule({ match: 'kroger', categoryId: food.id })

    expect(await api.applyPayeeRules()).toBe(1)
    const byPayee = Object.fromEntries(
      (await api.listInbox()).map((i) => [i.transaction.payee, categoryOf(i.transaction)]),
    )
    expect(byPayee).toEqual({ KROGER: food.id, 'KROGER FUEL': fun.id, ZOO: null })
    expect(await api.applyPayeeRules()).toBe(0)
  })

  it('does not touch approved transactions', async () => {
    const { api, food, checking } = await makeApi()
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-10-01',
      payee: 'Kroger',
      amount: -500,
    })
    await api.createPayeeRule({ match: 'kroger', categoryId: food.id })
    expect(await api.applyPayeeRules()).toBe(0)
  })
})
