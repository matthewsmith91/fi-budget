import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { goalProgress } from './goals.ts'
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
  const group = await api.createCategoryGroup({ name: 'Savings' })
  const home = await api.createCategory({ groupId: group.id, name: 'Home' })
  const fun = await api.createCategory({ groupId: group.id, name: 'Fun' })
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  await api.createTransaction({ accountId: checking.id, date: '2026-10-01', amount: 1_000_000 })
  return { api, adapter, home, fun, checking }
}

const OCT = '2026-10'

describe('goalProgress', () => {
  const laptop = { targetAmount: 120_000, targetDate: '2027-03-15' }

  it('spreads what is left over the months to the target, this one included', () => {
    // October through March is six months.
    const p = goalProgress(laptop, OCT, { assigned: 0, activity: 0, available: 0 })
    expect(p).toEqual({ percentFunded: 0, monthlyNeeded: 20_000, underfunded: 20_000 })
  })

  it('works from the opening balance, so assigning does not move the target', () => {
    const p = goalProgress(laptop, OCT, { assigned: 20_000, activity: 0, available: 20_000 })
    expect(p).toEqual({ percentFunded: 16, monthlyNeeded: 20_000, underfunded: 0 })
  })

  it('rounds the monthly amount up and the percent down', () => {
    const p = goalProgress({ targetAmount: 100_000, targetDate: '2026-12-01' }, OCT, {
      assigned: 0,
      activity: 0,
      available: 99_999,
    })
    expect(p.percentFunded).toBe(99)
    expect(p.monthlyNeeded).toBe(1)
    expect(
      goalProgress({ targetAmount: 100_000, targetDate: '2026-12-31' }, OCT, {
        assigned: 0,
        activity: 0,
        available: 0,
      }).monthlyNeeded,
    ).toBe(33_334)
  })

  it('wants the whole remainder once the date has passed', () => {
    const p = goalProgress({ targetAmount: 50_000, targetDate: '2026-01-01' }, OCT, {
      assigned: 0,
      activity: 0,
      available: 10_000,
    })
    expect(p).toMatchObject({ monthlyNeeded: 40_000, underfunded: 40_000 })
  })

  it('needs nothing from a funded goal, and has no monthly figure without a date', () => {
    expect(goalProgress(laptop, OCT, { assigned: 0, activity: 0, available: 130_000 })).toEqual({
      percentFunded: 100,
      monthlyNeeded: 0,
      underfunded: 0,
    })
    expect(
      goalProgress({ targetAmount: 100, targetDate: null }, OCT, {
        assigned: 0,
        activity: 0,
        available: 50,
      }),
    ).toEqual({ percentFunded: 50, monthlyNeeded: null, underfunded: 0 })
  })

  it('never reports a negative percent for an overdrawn goal', () => {
    expect(
      goalProgress(laptop, OCT, { assigned: 0, activity: -5_000, available: -5_000 }).percentFunded,
    ).toBe(0)
  })
})

describe('goals', () => {
  it('creates, edits and lists goals', async () => {
    const { api, home } = await makeApi()
    const goal = await api.createGoal({
      categoryId: home.id,
      name: ' Roof ',
      targetAmount: 800_000,
      targetDate: '2028-06-01',
    })
    expect(goal).toEqual({
      id: goal.id,
      categoryId: home.id,
      name: 'Roof',
      targetAmount: 800_000,
      targetDate: '2028-06-01',
      archived: false,
    })
    const edited = await api.updateGoal(goal.id, { name: 'New roof', targetDate: null })
    expect(edited).toMatchObject({ name: 'New roof', targetDate: null, targetAmount: 800_000 })
    expect(await api.listGoals()).toEqual([edited])
  })

  it('refuses a bad target, a duplicate name, and a card payment category', async () => {
    const { api, home, fun } = await makeApi()
    await api.createGoal({ categoryId: home.id, name: 'Roof', targetAmount: 100 })
    await expect(
      api.createGoal({ categoryId: home.id, name: 'ROOF', targetAmount: 100 }),
    ).rejects.toThrow(/already has a goal/)
    await api.createGoal({ categoryId: fun.id, name: 'Roof', targetAmount: 100 })
    await expect(
      api.createGoal({ categoryId: home.id, name: 'Deck', targetAmount: 0 }),
    ).rejects.toThrow(/more than zero/)
    await expect(
      api.createGoal({ categoryId: home.id, name: 'Deck', targetAmount: 1.5 }),
    ).rejects.toThrow(/whole number/)
    await expect(
      api.createGoal({ categoryId: home.id, name: 'Deck', targetAmount: 100, targetDate: 'soon' }),
    ).rejects.toThrow(/not a date/)
    await expect(
      api.createGoal({ categoryId: 'nope', name: 'Deck', targetAmount: 100 }),
    ).rejects.toThrow(/Category not found/)
    const visa = await api.createAccount({ name: 'Visa', type: 'credit' })
    await expect(
      api.createGoal({ categoryId: `payment-${visa.id}`, name: 'Deck', targetAmount: 100 }),
    ).rejects.toThrow(/payment category/)
  })

  describe('funding', () => {
    it('keeps goal money inside its category total', async () => {
      const { api, home } = await makeApi()
      const roof = await api.createGoal({
        categoryId: home.id,
        name: 'Roof',
        targetAmount: 100_000,
      })
      await api.allocate({ month: OCT, categoryId: home.id, amount: 30_000 })
      await api.allocate({ month: OCT, categoryId: home.id, goalId: roof.id, amount: 25_000 })

      const [cat] = (await api.getMonthBalances(OCT)).filter((b) => b.categoryId === home.id)
      expect(cat).toMatchObject({ assigned: 55_000, available: 55_000 })
      const [goal] = await api.getGoalBalances(OCT)
      expect(goal).toMatchObject({ goalId: roof.id, assigned: 25_000, available: 25_000 })
      expect(await api.getReadyToAssign(OCT)).toBe(1_000_000 - 55_000)
    })

    it('accumulates across months while the category rolls over', async () => {
      const { api, home } = await makeApi()
      const roof = await api.createGoal({
        categoryId: home.id,
        name: 'Roof',
        targetAmount: 100_000,
      })
      await api.allocate({ month: OCT, categoryId: home.id, goalId: roof.id, amount: 10_000 })
      await api.allocate({ month: '2026-11', categoryId: home.id, goalId: roof.id, amount: 5_000 })
      expect((await api.getGoalBalances('2026-11'))[0]).toMatchObject({
        assigned: 5_000,
        available: 15_000,
      })
      expect((await api.getGoalBalances(OCT))[0]).toMatchObject({ available: 10_000 })
      expect((await api.getGoalBalances('2026-12'))[0]).toMatchObject({
        assigned: 0,
        available: 15_000,
      })
    })

    it('moves money between a goal, its category and other goals', async () => {
      const { api, home, fun } = await makeApi()
      const roof = await api.createGoal({
        categoryId: home.id,
        name: 'Roof',
        targetAmount: 100_000,
      })
      const deck = await api.createGoal({
        categoryId: home.id,
        name: 'Deck',
        targetAmount: 100_000,
      })
      await api.allocate({ month: OCT, categoryId: home.id, amount: 40_000 })

      await api.moveAllocation({
        month: OCT,
        fromCategoryId: home.id,
        toCategoryId: home.id,
        toGoalId: roof.id,
        amount: 15_000,
      })
      await api.moveAllocation({
        month: OCT,
        fromCategoryId: home.id,
        fromGoalId: roof.id,
        toCategoryId: home.id,
        toGoalId: deck.id,
        amount: 5_000,
      })
      const goals = await api.getGoalBalances(OCT)
      expect(goals.map((g) => g.available)).toEqual([10_000, 5_000])
      // moving within a category changes nothing at the category level
      expect((await api.getMonthBalances(OCT)).find((b) => b.categoryId === home.id)).toMatchObject(
        {
          assigned: 40_000,
          available: 40_000,
        },
      )

      await expect(
        api.moveAllocation({
          month: OCT,
          fromCategoryId: home.id,
          toCategoryId: home.id,
          amount: 1,
        }),
      ).rejects.toThrow(/two different places/)
      await expect(
        api.moveAllocation({
          month: OCT,
          fromCategoryId: fun.id,
          toCategoryId: home.id,
          toGoalId: roof.id,
          amount: 1,
        }),
      ).resolves.toBeDefined()
      await expect(
        api.allocate({ month: OCT, categoryId: fun.id, goalId: roof.id, amount: 1 }),
      ).rejects.toThrow(/another category/)
      await expect(
        api.allocate({ month: OCT, categoryId: home.id, goalId: 'nope', amount: 1 }),
      ).rejects.toThrow(/Goal not found/)
    })

    it('lists a goal’s allocations', async () => {
      const { api, home } = await makeApi()
      const roof = await api.createGoal({ categoryId: home.id, name: 'Roof', targetAmount: 100 })
      await api.allocate({ month: OCT, categoryId: home.id, amount: 5 })
      await api.allocate({ month: OCT, categoryId: home.id, goalId: roof.id, amount: 7 })
      expect((await api.listAllocations({ goalId: roof.id })).map((a) => a.amount)).toEqual([7])
    })
  })

  describe('spending', () => {
    it('draws a goal down without touching the rest of its category', async () => {
      const { api, home, checking } = await makeApi()
      const laptop = await api.createGoal({
        categoryId: home.id,
        name: 'Laptop',
        targetAmount: 120_000,
      })
      await api.allocate({ month: OCT, categoryId: home.id, amount: 20_000 })
      await api.allocate({ month: OCT, categoryId: home.id, goalId: laptop.id, amount: 120_000 })

      const t = await api.createTransaction({
        accountId: checking.id,
        date: '2026-10-20',
        payee: 'Apple',
        categoryId: home.id,
        goalId: laptop.id,
        amount: -110_000,
      })
      expect(t.splits[0]).toMatchObject({ categoryId: home.id, goalId: laptop.id })

      expect((await api.getGoalBalances(OCT))[0]).toMatchObject({
        assigned: 120_000,
        activity: -110_000,
        available: 10_000,
        percentFunded: 8,
      })
      expect((await api.getMonthBalances(OCT)).find((b) => b.categoryId === home.id)).toMatchObject(
        {
          activity: -110_000,
          available: 30_000,
        },
      )
    })

    it('counts plain category spending toward the category only', async () => {
      const { api, home, checking } = await makeApi()
      const roof = await api.createGoal({ categoryId: home.id, name: 'Roof', targetAmount: 100 })
      await api.allocate({ month: OCT, categoryId: home.id, goalId: roof.id, amount: 100 })
      await api.createTransaction({
        accountId: checking.id,
        date: '2026-10-20',
        categoryId: home.id,
        amount: -40,
      })
      expect((await api.getGoalBalances(OCT))[0]).toMatchObject({ activity: 0, available: 100 })
    })

    it('lets a split spend from a goal and a category together', async () => {
      const { api, home, checking } = await makeApi()
      const roof = await api.createGoal({ categoryId: home.id, name: 'Roof', targetAmount: 100 })
      await api.allocate({ month: OCT, categoryId: home.id, goalId: roof.id, amount: 100 })
      const t = await api.createTransaction({
        accountId: checking.id,
        date: '2026-10-20',
        splits: [
          { categoryId: home.id, goalId: roof.id, amount: -30 },
          { categoryId: home.id, amount: -20 },
        ],
      })
      expect(t.splits.map((s) => s.goalId)).toEqual([roof.id, null])
      expect((await api.getGoalBalances(OCT))[0]).toMatchObject({ activity: -30, available: 70 })
    })

    it('does not count spending from a tracking account', async () => {
      const { api, home } = await makeApi()
      const roof = await api.createGoal({ categoryId: home.id, name: 'Roof', targetAmount: 100 })
      const tracked = await api.createAccount({ name: 'Brokerage', type: 'investment' })
      await api.createTransaction({
        accountId: tracked.id,
        date: '2026-10-20',
        categoryId: home.id,
        goalId: roof.id,
        amount: -30,
      })
      expect((await api.getGoalBalances(OCT))[0]).toMatchObject({ activity: 0, available: 0 })
    })

    it('drops the goal when the category changes, keeps it otherwise', async () => {
      const { api, home, fun, checking } = await makeApi()
      const roof = await api.createGoal({ categoryId: home.id, name: 'Roof', targetAmount: 100 })
      const deck = await api.createGoal({ categoryId: home.id, name: 'Deck', targetAmount: 100 })
      const t = await api.createTransaction({
        accountId: checking.id,
        date: '2026-10-20',
        categoryId: home.id,
        goalId: roof.id,
        amount: -30,
      })
      expect((await api.updateTransaction(t.id, { amount: -35 })).splits[0]).toMatchObject({
        goalId: roof.id,
        amount: -35,
      })
      expect((await api.updateTransaction(t.id, { goalId: deck.id })).splits[0]!.goalId).toBe(
        deck.id,
      )
      expect((await api.updateTransaction(t.id, { goalId: null })).splits[0]!.goalId).toBeNull()
      await api.updateTransaction(t.id, { goalId: roof.id })
      const moved = await api.updateTransaction(t.id, { categoryId: fun.id })
      expect(moved.splits[0]).toMatchObject({ categoryId: fun.id, goalId: null })
    })

    it('refuses a goal from another category, or one with no category', async () => {
      const { api, home, fun, checking } = await makeApi()
      const roof = await api.createGoal({ categoryId: home.id, name: 'Roof', targetAmount: 100 })
      const entry = { accountId: checking.id, date: '2026-10-20', amount: -30 }
      await expect(
        api.createTransaction({ ...entry, categoryId: fun.id, goalId: roof.id }),
      ).rejects.toThrow(/another category/)
      await expect(api.createTransaction({ ...entry, goalId: roof.id })).rejects.toThrow(
        /another category/,
      )
      const ok = await api.createTransaction({ ...entry, categoryId: fun.id })
      await expect(api.updateTransaction(ok.id, { goalId: roof.id })).rejects.toThrow(
        /another category/,
      )
    })
  })

  describe('archiving', () => {
    it('returns what is left to the category and keeps the history', async () => {
      const { api, home, checking } = await makeApi()
      const laptop = await api.createGoal({
        categoryId: home.id,
        name: 'Laptop',
        targetAmount: 100,
      })
      await api.allocate({ month: OCT, categoryId: home.id, goalId: laptop.id, amount: 100 })
      await api.createTransaction({
        accountId: checking.id,
        date: '2026-10-20',
        categoryId: home.id,
        goalId: laptop.id,
        amount: -90,
      })

      const archived = await api.archiveGoal(laptop.id, { month: OCT })
      expect(archived.archived).toBe(true)
      expect((await api.getGoalBalances(OCT))[0]).toMatchObject({ available: 0 })
      expect((await api.getMonthBalances(OCT)).find((b) => b.categoryId === home.id)).toMatchObject(
        {
          available: 10,
        },
      )
      expect(await api.listAllocations({ goalId: laptop.id })).toHaveLength(2)
      // archiving again changes nothing
      await api.archiveGoal(laptop.id, { month: OCT })
      expect(await api.listAllocations({ goalId: laptop.id })).toHaveLength(2)
    })

    it('settles an overdrawn goal from the category', async () => {
      const { api, home, checking } = await makeApi()
      const laptop = await api.createGoal({
        categoryId: home.id,
        name: 'Laptop',
        targetAmount: 100,
      })
      await api.allocate({ month: OCT, categoryId: home.id, amount: 50 })
      await api.createTransaction({
        accountId: checking.id,
        date: '2026-10-20',
        categoryId: home.id,
        goalId: laptop.id,
        amount: -30,
      })
      await api.archiveGoal(laptop.id, { month: OCT })
      expect((await api.getGoalBalances(OCT))[0]!.available).toBe(0)
      expect((await api.getMonthBalances(OCT)).find((b) => b.categoryId === home.id)).toMatchObject(
        {
          available: 20,
        },
      )
    })

    it('takes no more money or spending, but old transactions stay editable', async () => {
      const { api, home, checking } = await makeApi()
      const laptop = await api.createGoal({
        categoryId: home.id,
        name: 'Laptop',
        targetAmount: 100,
      })
      const t = await api.createTransaction({
        accountId: checking.id,
        date: '2026-10-20',
        categoryId: home.id,
        goalId: laptop.id,
        amount: -30,
      })
      await api.archiveGoal(laptop.id, { month: OCT })
      await expect(
        api.allocate({ month: OCT, categoryId: home.id, goalId: laptop.id, amount: 5 }),
      ).rejects.toThrow(/archived/)
      await expect(
        api.createTransaction({
          accountId: checking.id,
          date: '2026-10-21',
          categoryId: home.id,
          goalId: laptop.id,
          amount: -5,
        }),
      ).rejects.toThrow(/archived/)
      expect((await api.updateTransaction(t.id, { amount: -31 })).splits[0]!.goalId).toBe(laptop.id)
      expect(
        (
          await api.updateTransaction(t.id, {
            splits: [{ categoryId: home.id, goalId: laptop.id, amount: -32 }],
          })
        ).amount,
      ).toBe(-32)
    })

    it('frees the name, and unarchiving refuses a clash', async () => {
      const { api, home } = await makeApi()
      const old = await api.createGoal({ categoryId: home.id, name: 'Roof', targetAmount: 100 })
      await api.archiveGoal(old.id, { month: OCT })
      const fresh = await api.createGoal({ categoryId: home.id, name: 'Roof', targetAmount: 200 })
      await expect(api.unarchiveGoal(old.id)).rejects.toThrow(/already has a goal/)
      await api.archiveGoal(fresh.id, { month: OCT })
      expect((await api.unarchiveGoal(old.id)).archived).toBe(false)
    })
  })

  describe('deleting', () => {
    it('deletes a goal with no history, and refuses one with', async () => {
      const { api, home } = await makeApi()
      const unused = await api.createGoal({ categoryId: home.id, name: 'Unused', targetAmount: 1 })
      const used = await api.createGoal({ categoryId: home.id, name: 'Used', targetAmount: 1 })
      await api.allocate({ month: OCT, categoryId: home.id, goalId: used.id, amount: 1 })
      await api.deleteGoal(unused.id)
      await expect(api.deleteGoal(used.id)).rejects.toThrow(/history/)
      expect((await api.listGoals()).map((g) => g.name)).toEqual(['Used'])
    })

    it('goes with a category that has no history', async () => {
      const { api, home } = await makeApi()
      await api.createGoal({ categoryId: home.id, name: 'Unused', targetAmount: 1 })
      await api.deleteCategory(home.id)
      expect(await api.listGoals()).toEqual([])
    })

    it('keeps a category with goal history', async () => {
      const { api, home } = await makeApi()
      const roof = await api.createGoal({ categoryId: home.id, name: 'Roof', targetAmount: 1 })
      await api.allocate({ month: OCT, categoryId: home.id, goalId: roof.id, amount: 1 })
      await expect(api.deleteCategory(home.id)).rejects.toThrow(/history/)
    })
  })

  it('describes goal allocations in the activity feed', async () => {
    const { api, home } = await makeApi()
    const roof = await api.createGoal({ categoryId: home.id, name: 'Roof', targetAmount: 1000 })
    await api.allocate({ month: OCT, categoryId: home.id, goalId: roof.id, amount: 500 })
    const { events } = await api.listActivity()
    expect(events.map((e) => e.summary)).toEqual(
      expect.arrayContaining(['Added goal “Roof”', 'Assigned $5.00 to Roof in Home for 2026-10']),
    )
  })
})
