import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { openMemoryAdapter } from './test-utils.ts'

async function makeApi(opts: { deviceId?: string } = {}) {
  const adapter = await openMemoryAdapter()
  let n = 0
  let ms = Date.parse('2026-01-01T00:00:00.000Z')
  const api = createBudgetApi({
    adapter,
    storage: 'memory',
    sqliteVersion: 'test',
    deviceId: opts.deviceId ?? '0123456789abcdef',
    newId: () => `id-${++n}`,
    // every call to now() is a millisecond later, so each write has its own timestamps
    now: () => new Date((ms += 1)).toISOString(),
  })
  return { api, adapter }
}

describe('activity feed', () => {
  it('describes what happened, newest first', async () => {
    const { api } = await makeApi()
    const group = await api.createCategoryGroup({ name: 'Bills' })
    const rent = await api.createCategory({ groupId: group.id, name: 'Rent' })
    const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
    await api.allocate({ month: '2026-01', categoryId: rent.id, amount: 150000 })
    await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-03',
      payee: 'Landlord',
      categoryId: rent.id,
      amount: -150000,
    })
    const { events, next } = await api.listActivity()
    expect(next).toBeNull()
    expect(events.map((e) => e.summary)).toEqual([
      'Added “Landlord” for -$1,500.00 in Checking',
      'Assigned $1,500.00 to Rent for 2026-01',
      'Added account “Checking”',
      'Added category “Rent”',
      'Added category group “Bills”',
    ])
    expect(events.every((e) => e.kind === 'created')).toBe(true)
    expect(events[0]).toMatchObject({ table: 'transactions', deviceId: '0123456789abcdef' })
  })

  it('reports edits with the fields that changed, and deletions by the name that was recorded', async () => {
    const { api } = await makeApi()
    const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
    await api.updateAccount(checking.id, { name: 'Main', closed: true })
    await api.deleteAccount(checking.id)
    const { events } = await api.listActivity()
    expect(events.map((e) => [e.kind, e.summary, e.fields])).toEqual([
      ['deleted', 'Deleted account “Main”', []],
      ['changed', 'Changed account “Main” (name, closed)', ['name', 'closed']],
      ['created', 'Added account “Checking”', []],
    ])
  })

  it('shows a transaction edit, a category change on its split and a deletion', async () => {
    const { api } = await makeApi()
    const group = await api.createCategoryGroup({ name: 'Bills' })
    const food = await api.createCategory({ groupId: group.id, name: 'Food' })
    const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
    const t = await api.createTransaction({
      accountId: checking.id,
      date: '2026-01-03',
      payee: 'Kroger',
      amount: -1000,
    })
    await api.updateTransaction(t.id, { cleared: true })
    await api.updateTransaction(t.id, { categoryId: food.id })
    await api.deleteTransaction(t.id)
    const summaries = (await api.listActivity()).events.map((e) => e.summary).slice(0, 4)
    expect(summaries).toEqual([
      'Deleted “Kroger”',
      'Changed the category or amount of “Kroger”',
      'Changed “Kroger” (cleared)',
      'Added “Kroger” for -$10.00 in Checking',
    ])
  })

  it('shows a transfer once and a payment category with its card', async () => {
    const { api } = await makeApi()
    const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
    const savings = await api.createAccount({ name: 'Savings', type: 'savings' })
    await api.createTransfer({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      date: '2026-01-03',
      amount: 5000,
    })
    const summaries = (await api.listActivity()).events.map((e) => e.summary)
    expect(summaries.slice(0, 2)).toEqual([
      'Transferred $50.00 into Savings',
      'Transferred $50.00 out of Checking',
    ])
  })

  it('leaves out reordering', async () => {
    const { api } = await makeApi()
    const a = await api.createCategoryGroup({ name: 'A' })
    const b = await api.createCategoryGroup({ name: 'B' })
    await api.reorderCategoryGroups([b.id, a.id])
    const summaries = (await api.listActivity()).events.map((e) => e.summary)
    expect(summaries).toEqual(['Added category group “B”', 'Added category group “A”'])
  })

  it('pages with a cursor', async () => {
    const { api } = await makeApi()
    for (const name of ['A', 'B', 'C', 'D', 'E']) await api.createCategoryGroup({ name })
    const first = await api.listActivity({ limit: 2 })
    expect(first.events.map((e) => e.summary)).toEqual([
      'Added category group “E”',
      'Added category group “D”',
    ])
    expect(first.next).not.toBeNull()
    const second = await api.listActivity({ limit: 2, before: first.next! })
    expect(second.events.map((e) => e.summary)).toEqual([
      'Added category group “C”',
      'Added category group “B”',
    ])
    const third = await api.listActivity({ limit: 2, before: second.next! })
    expect(third.events.map((e) => e.summary)).toEqual(['Added category group “A”'])
    expect(third.next).toBeNull()
  })

  it('says who made a change once the device is tied to a person', async () => {
    const { api } = await makeApi()
    const household = await api.createHousehold({ name: 'Smiths', members: ['Matt', 'Jessica'] })
    expect(await api.getDevice()).toBeNull()
    const matt = household.members[0]!
    expect(await api.setDevice({ name: ' Matt’s phone ', memberId: matt.id })).toEqual({
      id: '0123456789abcdef',
      name: 'Matt’s phone',
      memberId: matt.id,
    })
    await api.createCategoryGroup({ name: 'Bills' })
    const [event] = (await api.listActivity()).events
    expect(event).toMatchObject({ memberName: 'Matt', deviceName: 'Matt’s phone' })
    // changing it replaces the row instead of adding another
    await api.setDevice({ name: 'Matt’s laptop', memberId: null })
    expect((await api.getDevice())!.name).toBe('Matt’s laptop')
    await expect(api.setDevice({ name: 'x', memberId: 'nobody' })).rejects.toThrow(/not found/)
    await expect(api.setDevice({ name: ' ', memberId: null })).rejects.toThrow(/name/)
  })

  it('does not list household or device setup', async () => {
    const { api } = await makeApi()
    const household = await api.createHousehold({ name: 'Smiths', members: ['Matt'] })
    await api.setDevice({ name: 'Phone', memberId: household.members[0]!.id })
    expect((await api.listActivity()).events).toEqual([])
  })
})
