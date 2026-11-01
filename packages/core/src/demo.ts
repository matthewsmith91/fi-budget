import type { Account } from './accounts.ts'
import type { BudgetApi } from './api.ts'
import { shiftMonth } from './retirement.ts'

/**
 * Fills an empty, migrated budget with a believable household so every screen has something
 * to show. It goes through the public `BudgetApi` only, so each rule (income rules, unit
 * ledger, card payment categories) runs exactly as it does for a person typing, and it keeps
 * working when internals change. Dates are relative to `today`, so the demo never goes stale.
 *
 * The story: Matt and Jessica, ten months of history. The emergency fund is half built, the
 * sinking-fund account holds less than its goals say, Dining Out and Car Maintenance are
 * overspent this month, Property Tax is behind, and the inbox has bank transactions waiting
 * (one of them a paycheck whose income rules run when it is approved).
 */

/** Months of history, ending with the month that holds `today`. */
export const DEMO_HISTORY_MONTHS = 12

const usd = (dollars: number) => Math.round(dollars * 100)
const pad = (n: number) => String(n).padStart(2, '0')

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Small deterministic generator so the demo is the same every run. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `total` cents split into `n` uneven positive parts. */
function split(total: number, n: number, rand: () => number): number[] {
  const weights = Array.from({ length: n }, () => 0.6 + rand() * 0.8)
  const sum = weights.reduce((a, b) => a + b, 0)
  const parts = weights.map((w) => Math.floor((total * w) / sum))
  parts[0]! += total - parts.reduce((a, b) => a + b, 0)
  return parts
}

interface Spend {
  /** Dollars for the month; defaults to the plan times `ratio`. */
  total?: number
  ratio?: number
  n: number
  merchants: string[]
  /** A fixed day of the month; otherwise the purchases spread across it. */
  day?: number
  /** How much the month's total wobbles, as a share (fixed-day bills are exact by default). */
  vary?: number
  /** Share of purchases that go on the Visa. */
  card?: number
}

interface CatDef {
  name: string
  need?: boolean
  /** Dollars assigned by hand each month (income rules add to some on top). */
  plan: number
  spend?: Spend
}

const GROUPS: { name: string; cats: CatDef[] }[] = [
  {
    name: 'Bills',
    cats: [
      { name: 'Mortgage', need: true, plan: 2100 }, // paid by transfer to the mortgage account
      {
        name: 'Electric & Gas',
        need: true,
        plan: 220,
        spend: { total: 205, n: 1, day: 12, vary: 0.1, merchants: ['Austin Energy'] },
      },
      {
        name: 'Water & Trash',
        need: true,
        plan: 90,
        spend: { total: 88, n: 1, day: 20, merchants: ['City Utilities'] },
      },
      {
        name: 'Internet',
        need: true,
        plan: 80,
        spend: { total: 79.99, n: 1, day: 8, merchants: ['Google Fiber'] },
      },
      {
        name: 'Phone',
        need: true,
        plan: 130,
        spend: { total: 128.4, n: 1, day: 22, merchants: ['Mint Mobile'], card: 1 },
      },
      {
        name: 'Car Insurance',
        need: true,
        plan: 165,
        spend: { total: 164.5, n: 1, day: 10, merchants: ['State Farm'] },
      },
    ],
  },
  {
    name: 'Everyday',
    cats: [
      {
        name: 'Groceries',
        need: true,
        plan: 1200,
        spend: {
          ratio: 0.97,
          n: 7,
          merchants: ['Kroger', 'Costco', 'Aldi', "Trader Joe's"],
          card: 0.6,
        },
      },
      {
        name: 'Fuel',
        need: true,
        plan: 280,
        spend: { ratio: 0.9, n: 4, merchants: ['Shell', 'Costco Gas', 'BP'], card: 0.7 },
      },
      {
        name: 'Dining Out',
        plan: 250,
        spend: {
          ratio: 0.94,
          n: 6,
          merchants: ['Chipotle', 'Chick-fil-A', 'Torchy’s Tacos', 'Pizza Hut', 'Starbucks'],
          card: 0.8,
        },
      },
      {
        name: 'Household Supplies',
        need: true,
        plan: 150,
        spend: { ratio: 0.85, n: 3, merchants: ['Target', 'Home Depot', 'Amazon'], card: 0.8 },
      },
      {
        name: 'Medical',
        need: true,
        plan: 120,
        spend: { ratio: 0.6, n: 2, merchants: ['CVS Pharmacy', 'Austin Family Clinic'] },
      },
    ],
  },
  {
    name: 'Fun',
    cats: [
      {
        name: 'Entertainment',
        plan: 100,
        spend: { ratio: 0.45, n: 2, merchants: ['AMC Theatres', 'Alamo Drafthouse'], card: 1 },
      },
      {
        name: 'Hobbies',
        plan: 100,
        spend: { ratio: 0.4, n: 1, merchants: ['REI', 'Michaels'], card: 1 },
      },
      {
        name: 'Clothing',
        plan: 120,
        spend: { ratio: 0.3, n: 1, merchants: ['Old Navy', 'Nordstrom Rack'], card: 1 },
      },
      { name: 'Subscriptions', plan: 45 }, // fixed amounts, below
    ],
  },
  {
    name: 'Kids',
    cats: [
      {
        name: 'Childcare & Activities',
        need: true,
        plan: 450,
        spend: { total: 440, n: 1, day: 3, merchants: ['Bright Horizons'] },
      },
      {
        name: 'School',
        need: true,
        plan: 60,
        spend: { ratio: 0.5, n: 1, merchants: ['Scholastic', 'Lakeview Elementary PTA'] },
      },
    ],
  },
  {
    name: 'Giving',
    cats: [
      { name: 'Tithe', need: true, plan: 0 }, // income rules fill it; paid below
      {
        name: 'Charity',
        plan: 100,
        spend: { ratio: 0.8, n: 1, merchants: ['Central Texas Food Bank', 'Red Cross'] },
      },
    ],
  },
  {
    name: 'Sinking Funds',
    cats: [
      { name: 'Car Maintenance', need: true, plan: 100 },
      { name: 'Property Tax', need: true, plan: 350 }, // goal below
      { name: 'Home Repairs', need: true, plan: 200 }, // goal below
      { name: 'Travel', plan: 300 }, // goal below
      { name: 'Christmas', plan: 150 },
    ],
  },
  {
    name: 'Saving & Investing',
    cats: [
      { name: 'Roth IRA – Matt', plan: 500 },
      { name: 'Roth IRA – Jessica', plan: 500 },
      { name: 'Emma’s College', plan: 200 },
      { name: 'Brokerage', plan: 500 },
    ],
  },
]

const SUBSCRIPTIONS: [payee: string, dollars: number, day: number][] = [
  ['Netflix', 15.49, 18],
  ['Spotify', 11.99, 5],
  ['iCloud', 9.99, 14],
]

export async function seedDemoBudget(api: BudgetApi, opts: { today: string }): Promise<void> {
  const { today } = opts
  const rand = mulberry32(20261031)
  const thisMonth = today.slice(0, 7)
  const firstMonth = shiftMonth(thisMonth, -(DEMO_HISTORY_MONTHS - 1))
  const start = `${firstMonth}-01`
  const months = Array.from({ length: DEMO_HISTORY_MONTHS }, (_, i) => shiftMonth(firstMonth, i))
  /** A day this month that is not after today (so it stays in the month shown). */
  const recent = (daysAgo: number) => {
    const d = addDays(today, -daysAgo)
    return d < `${thisMonth}-01` ? `${thisMonth}-01` : d
  }
  /** Recent days are still waiting for the bank. */
  const isCleared = (date: string) => date <= addDays(today, -3)

  const household = await api.createHousehold({
    name: 'Demo Household',
    members: ['Matt', 'Jessica'],
  })
  const [matt, jessica] = household.members as [
    { id: string; displayName: string },
    { id: string; displayName: string },
  ]

  // ---- accounts --------------------------------------------------------------------------
  const checking = await api.createAccount({ name: 'Joint Checking', type: 'checking' })
  const emergencySavings = await api.createAccount({ name: 'Emergency Savings', type: 'savings' })
  const sinking = await api.createAccount({ name: 'Sinking Funds Savings', type: 'savings' })
  const visa = await api.createAccount({ name: 'Visa Rewards', type: 'credit' })
  const oldSavings = await api.createAccount({ name: 'Old Savings', type: 'savings' })
  const mortgage = await api.createAccount({ name: 'Mortgage', type: 'credit', onBudget: false })
  const home = await api.createAccount({
    name: 'Home (estimated value)',
    type: 'checking',
    onBudget: false,
  })
  const mattRoth = await api.createAccount({
    name: 'Matt Roth IRA',
    type: 'investment',
    investment: { kind: 'ira', taxType: 'roth', ownerId: matt.id },
  })
  const jessicaRoth = await api.createAccount({
    name: 'Jessica Roth IRA',
    type: 'investment',
    investment: { kind: 'ira', taxType: 'roth', ownerId: jessica.id },
  })
  const mattK = await api.createAccount({
    name: 'Matt 401(k)',
    type: 'investment',
    investment: { kind: '401k', taxType: 'traditional', ownerId: matt.id },
  })
  const brokerage = await api.createAccount({
    name: 'Brokerage',
    type: 'investment',
    investment: { kind: 'brokerage', taxType: 'taxable', ownerId: null, mode: 'units' },
  })
  const college = await api.createAccount({
    name: 'Emma 529',
    type: 'investment',
    investment: { kind: '529', taxType: '529', ownerId: null, mode: 'holdings' },
  })

  // ---- categories ------------------------------------------------------------------------
  const cat: Record<string, string> = {}
  for (const g of GROUPS) {
    const group = await api.createCategoryGroup({ name: g.name })
    for (const c of g.cats) {
      const made = await api.createCategory({
        groupId: group.id,
        name: c.name,
        needOrWant: c.need ? 'need' : 'want',
      })
      cat[c.name] = made.id
    }
  }
  const fund = await api.createEmergencyFund({ months: 6, window: 12 })
  const emergency = fund.categoryId!

  // In retirement: the mortgage and kids' costs end, medical costs more, travel more.
  await api.updateCategory(cat['Mortgage']!, { retirementStatus: 'ends' })
  await api.updateCategory(cat['Childcare & Activities']!, { retirementStatus: 'ends' })
  await api.updateCategory(cat['School']!, { retirementStatus: 'ends' })
  await api.updateCategory(cat['Medical']!, {
    retirementStatus: 'changes',
    retirementMultiplier: 1.6,
  })
  await api.updateCategory(cat['Fuel']!, { retirementStatus: 'changes', retirementMultiplier: 0.6 })

  // ---- goals -----------------------------------------------------------------------------
  const goalDate = (monthsAhead: number) => `${shiftMonth(thisMonth, monthsAhead)}-01`
  const propertyTax = await api.createGoal({
    categoryId: cat['Property Tax']!,
    name: 'Property tax bill',
    targetAmount: usd(4800),
    targetDate: goalDate(1), // due soon and short: an underfunded goal
    heldInAccountId: sinking.id,
  })
  const roof = await api.createGoal({
    categoryId: cat['Home Repairs']!,
    name: 'New roof',
    targetAmount: usd(12000),
    targetDate: goalDate(20),
    heldInAccountId: sinking.id,
  })
  const springBreak = await api.createGoal({
    categoryId: cat['Travel']!,
    name: 'Spring break trip',
    targetAmount: usd(3000),
    targetDate: goalDate(5),
    heldInAccountId: sinking.id,
  })
  const emma = await api.createGoal({
    categoryId: cat['Emma’s College']!,
    name: 'Emma’s tuition',
    targetAmount: usd(40000),
  })
  const house = await api.createGoal({
    categoryId: cat['Brokerage']!,
    name: 'House down payment',
    targetAmount: usd(60000),
  })
  const goalOf: Record<string, string> = {
    'Property Tax': propertyTax.id,
    'Home Repairs': roof.id,
    Travel: springBreak.id,
    'Emma’s College': emma.id,
    Brokerage: house.id,
  }

  // ---- rules (before any income, so they run as paychecks arrive) ---------------------------
  await api.createIncomeRule({
    name: 'Tithe on Matt’s pay',
    match: 'Acme',
    basis: 'gross',
    percent: 10,
    categoryId: cat['Tithe']!,
    priority: 1,
  })
  await api.createIncomeRule({
    name: 'Tithe on Jessica’s pay',
    match: 'Northwind',
    basis: 'net',
    percent: 10,
    categoryId: cat['Tithe']!,
    priority: 2,
  })
  await api.createIncomeRule({
    name: 'Emergency fund from Matt’s pay',
    match: 'Acme',
    basis: 'gross',
    percent: 5,
    categoryId: emergency,
    priority: 3,
  })
  for (const [match, category] of [
    ['Kroger', 'Groceries'],
    ['Costco', 'Groceries'],
    ['Shell', 'Fuel'],
    ['Chipotle', 'Dining Out'],
    ['Netflix', 'Subscriptions'],
    ['Spotify', 'Subscriptions'],
  ] as const) {
    await api.createPayeeRule({ match, categoryId: cat[category]! })
  }

  // ---- opening balances ------------------------------------------------------------------
  const open = async (account: Account, dollars: number) => {
    await api.createTransaction({
      accountId: account.id,
      date: start,
      payee: 'Starting Balance',
      amount: usd(dollars),
      cleared: true,
    })
  }
  await open(checking, 1500)
  await open(emergencySavings, 12500)
  await open(sinking, 3500)
  await open(oldSavings, 2000)
  await open(mortgage, -285000)
  await open(home, 465000)

  // Investment accounts start from a valuation; their contributions are transfers.
  const values = new Map<string, number>()
  const invest = async (account: Account, dollars: number) => {
    values.set(account.id, usd(dollars))
    await api.recordValuation({ accountId: account.id, date: start, marketValue: usd(dollars) })
  }
  await invest(mattRoth, 31000)
  await invest(jessicaRoth, 18500)
  await invest(mattK, 142000)
  await invest(brokerage, 38000)
  await invest(college, 9500)

  const index = await api.createHolding({
    accountId: college.id,
    name: 'Target 2036 Fund',
    goalId: emma.id,
    price: 4200,
  })
  await api.recordTrade({
    holdingId: index.id,
    type: 'buy',
    date: start,
    shares: usd(9500) / 4200,
    price: 4200,
  })

  // ---- the months ------------------------------------------------------------------------
  const cardCharged = new Map<string, number>()
  const note = (month: string, cents: number) =>
    cardCharged.set(month, (cardCharged.get(month) ?? 0) + cents)

  /** Jessica is paid every other week, ending yesterday, so a paycheck sits in the inbox. */
  const jessicaPayDays: string[] = []
  for (let d = addDays(today, -1); d >= start; d = addDays(d, -14)) jessicaPayDays.push(d)
  const inboxPayday = jessicaPayDays[0]!

  const returns = [
    0.012, -0.021, 0.034, 0.008, 0.019, -0.012, 0.027, 0.015, -0.006, 0.021, 0.009, 0.017,
  ]
  const contributions = new Map<string, number>()

  for (const [i, month] of months.entries()) {
    const day = (d: number) => `${month}-${pad(d)}`
    const upTo = (date: string) => date <= today

    // What is assigned by hand. In the month under way only what has actually arrived can be
    // assigned (the plan runs in order until the money does), so Ready to Assign never goes
    // negative however early in the month the demo is opened.
    const assignPlan = async () => {
      const current = month === thisMonth
      for (const g of GROUPS) {
        for (const c of g.cats) {
          const opening: Record<string, number> = {
            'Home Repairs': 1500,
            Travel: 500,
            Christmas: 1000,
          }
          const amount = usd(c.plan + (i === 0 ? (opening[c.name] ?? 0) : 0))
          if (amount === 0) continue
          if (current && amount > (await api.getReadyToAssign(month))) continue
          await api.allocate({
            month,
            categoryId: cat[c.name]!,
            goalId: goalOf[c.name],
            amount,
          })
        }
      }
      if (i === 0) {
        await api.allocate({ month, categoryId: emergency, amount: usd(12000), note: 'Opening' })
      }
    }
    if (month !== thisMonth) await assignPlan()

    // Paychecks: income rules run as each is entered.
    for (const [d, net, gross] of [
      [1, 2850, 3500],
      [15, 2850, 3500],
    ] as const) {
      if (!upTo(day(d))) continue
      await api.createTransaction({
        accountId: checking.id,
        date: day(d),
        payee: 'Acme Corp Payroll',
        amount: usd(net),
        grossAmount: usd(gross),
        cleared: isCleared(day(d)),
      })
    }
    for (const date of jessicaPayDays) {
      if (date.slice(0, 7) !== month || date === inboxPayday) continue
      await api.createTransaction({
        accountId: checking.id,
        date,
        payee: 'Northwind Health Payroll',
        amount: usd(1900),
        grossAmount: usd(2300),
        cleared: isCleared(date),
      })
    }

    if (month === thisMonth) await assignPlan()

    // Bills and everyday spending.
    for (const g of GROUPS) {
      for (const c of g.cats) {
        const s = c.spend
        if (!s) continue
        const total = usd(
          (s.total ?? c.plan * (s.ratio ?? 1)) *
            (1 - (s.vary ?? (s.day ? 0 : 0.06)) + rand() * 2 * (s.vary ?? (s.day ? 0 : 0.06))),
        )
        const parts = split(total, s.n, rand)
        for (const [k, cents] of parts.entries()) {
          const d = s.day ?? Math.min(27, Math.round(2 + ((k + rand() * 0.8) * 25) / s.n))
          const date = day(d)
          if (!upTo(date)) continue
          const onCard = rand() < (s.card ?? 0)
          await api.createTransaction({
            accountId: (onCard ? visa : checking).id,
            date,
            payee: s.merchants[(k + i) % s.merchants.length]!,
            categoryId: cat[c.name]!,
            amount: -cents,
            cleared: isCleared(date),
          })
          if (onCard) note(month, cents)
        }
      }
    }
    for (const [payee, dollars, d] of SUBSCRIPTIONS) {
      if (!upTo(day(d))) continue
      await api.createTransaction({
        accountId: visa.id,
        date: day(d),
        payee,
        categoryId: cat['Subscriptions']!,
        amount: -usd(dollars),
        cleared: isCleared(day(d)),
      })
      note(month, usd(dollars))
    }

    // A couple of repairs earlier in the year, paid from the Car Maintenance envelope.
    for (const [at, payee, dollars] of [
      [4, 'Jiffy Lube', 89.99],
      [8, 'Discount Tire', 612.4],
    ] as const) {
      if (i !== at || !upTo(day(17))) continue
      await api.createTransaction({
        accountId: visa.id,
        date: day(17),
        payee,
        categoryId: cat['Car Maintenance']!,
        amount: -usd(dollars),
        cleared: isCleared(day(17)),
      })
      note(month, usd(dollars))
    }

    // Last month's tithe goes out on the 3rd.
    if (i > 0 && upTo(day(3))) {
      const prev = await api.getMonthBalances(months[i - 1]!)
      const owed = prev.find((b) => b.categoryId === cat['Tithe'])?.available ?? 0
      if (owed > 0) {
        await api.createTransaction({
          accountId: checking.id,
          date: day(3),
          payee: 'Hill Country Community Church',
          categoryId: cat['Tithe']!,
          amount: -owed,
          cleared: isCleared(day(3)),
        })
      }
    }

    // Money moves between accounts. The mortgage is a categorized transfer out of the budget.
    const transfer = async (
      from: Account,
      to: Account,
      d: number,
      dollars: number,
      extra: { categoryId?: string; goalId?: string } = {},
    ) => {
      if (!upTo(day(d))) return
      await api.createTransfer({
        fromAccountId: from.id,
        toAccountId: to.id,
        date: day(d),
        amount: usd(dollars),
        cleared: isCleared(day(d)),
        ...extra,
      })
      if (to.type === 'investment') {
        contributions.set(to.id, (contributions.get(to.id) ?? 0) + usd(dollars))
      }
    }
    await transfer(checking, mortgage, 1, 2100, { categoryId: cat['Mortgage']! })
    await transfer(checking, emergencySavings, 6, 350)
    await transfer(checking, sinking, 6, 150)
    await transfer(checking, mattRoth, 4, 500, { categoryId: cat['Roth IRA – Matt']! })
    await transfer(checking, jessicaRoth, 4, 500, { categoryId: cat['Roth IRA – Jessica']! })
    await transfer(checking, college, 4, 200, {
      categoryId: cat['Emma’s College']!,
      goalId: emma.id,
    })
    await transfer(checking, brokerage, 4, 500, {
      categoryId: cat['Brokerage']!,
      goalId: house.id,
    })
    if (i === 3) {
      await api.createTransfer({
        fromAccountId: oldSavings.id,
        toAccountId: checking.id,
        date: day(10),
        amount: usd(2000),
        cleared: true,
      })
      await api.updateAccount(oldSavings.id, { closed: true })
    }

    // The card is paid off on the 5th for the month before.
    if (i > 0 && upTo(day(5))) {
      const owed = cardCharged.get(months[i - 1]!) ?? 0
      if (owed > 0) {
        await api.createTransfer({
          fromAccountId: checking.id,
          toAccountId: visa.id,
          date: day(5),
          amount: owed,
          cleared: isCleared(day(5)),
        })
      }
    }

    // Market values drift; contributions go in on top.
    const valueDate = upTo(day(28)) ? day(28) : today
    for (const [account, growth, payroll] of [
      [mattRoth, 1, 0],
      [jessicaRoth, 1, 0],
      [mattK, 1, usd(1100)],
      [brokerage, 1, 0],
      [college, 1, 0],
    ] as const) {
      const was = values.get(account.id)!
      const now =
        Math.round(was * (1 + returns[i]! * growth)) +
        (contributions.get(account.id) ?? 0) +
        payroll
      contributions.delete(account.id)
      values.set(account.id, now)
      await api.recordValuation({ accountId: account.id, date: valueDate, marketValue: now })
    }
  }

  // ---- this month's trouble --------------------------------------------------------------
  const balances = await api.getMonthBalances(thisMonth)
  const available = (name: string) => balances.find((b) => b.categoryId === cat[name])!.available

  // Dining Out and Car Maintenance both end the month overspent.
  const dinner = Math.max(0, available('Dining Out')) + usd(62)
  const [dinnerA, dinnerB] = split(dinner, 2, rand)
  await api.createTransaction({
    accountId: visa.id,
    date: recent(2),
    payee: 'Uchi',
    categoryId: cat['Dining Out']!,
    amount: -dinnerA!,
    cleared: isCleared(recent(2)),
  })
  await api.createTransaction({
    accountId: visa.id,
    date: recent(1),
    payee: 'Hopdoddy',
    categoryId: cat['Dining Out']!,
    amount: -dinnerB!,
    cleared: isCleared(recent(1)),
  })
  const repair = Math.max(0, available('Car Maintenance')) + usd(85)
  await api.createTransaction({
    accountId: checking.id,
    date: recent(4),
    payee: 'Firestone Complete Auto Care',
    categoryId: cat['Car Maintenance']!,
    amount: -repair,
    cleared: isCleared(recent(4)),
  })

  // A split purchase, one line tagged as a want; and a refund.
  await api.createTransaction({
    accountId: visa.id,
    date: recent(6),
    payee: 'Costco',
    splits: [
      { categoryId: cat['Groceries']!, amount: -usd(96.4) },
      { categoryId: cat['Household Supplies']!, amount: -usd(41.2) },
      { categoryId: cat['Entertainment']!, needOrWant: 'want', amount: -usd(19.99) },
    ],
    cleared: isCleared(recent(6)),
  })
  await api.createTransaction({
    accountId: visa.id,
    date: recent(7),
    payee: 'Amazon refund',
    categoryId: cat['Household Supplies']!,
    amount: usd(24.99),
    cleared: isCleared(recent(7)),
  })

  // A manual entry the bank's copy will fold into.
  await api.createTransaction({
    accountId: visa.id,
    date: recent(3),
    payee: 'Home Depot',
    categoryId: cat['Household Supplies']!,
    amount: -usd(38.91),
    cleared: false,
  })

  // ---- the inbox: what the bank sent that nobody has looked at -------------------------------
  await api.mapExternalAccount({
    externalId: 'sf-checking',
    name: 'Joint Checking ••4821',
    org: 'Hill Country Credit Union',
    accountId: checking.id,
  })
  await api.mapExternalAccount({
    externalId: 'sf-visa',
    name: 'Visa Rewards ••9034',
    org: 'Hill Country Credit Union',
    accountId: visa.id,
  })
  await api.importTransactions([
    {
      id: 'sf-checking',
      name: 'Joint Checking ••4821',
      org: 'Hill Country Credit Union',
      transactions: [
        {
          id: 'chk-1',
          posted: inboxPayday,
          amount: usd(1900),
          description: 'NORTHWIND HEALTH PAYROLL',
        },
        { id: 'chk-2', posted: recent(1), amount: -usd(86.42), description: 'KROGER #412' },
        { id: 'chk-3', posted: recent(2), amount: -usd(52.1), description: 'SHELL OIL 5741' },
        { id: 'chk-4', posted: recent(2), amount: usd(120), description: 'VENMO CASHOUT' },
        { id: 'chk-5', posted: recent(3), amount: -usd(88), description: 'CITY UTILITIES' },
      ],
    },
    {
      id: 'sf-visa',
      name: 'Visa Rewards ••9034',
      org: 'Hill Country Credit Union',
      transactions: [
        { id: 'visa-1', posted: recent(0), amount: -usd(43.17), description: 'AMZN MKTP US*2K4' },
        { id: 'visa-2', posted: recent(1), amount: -usd(212.6), description: 'COSTCO WHSE #1042' },
        { id: 'visa-3', posted: recent(1), amount: -usd(67.33), description: 'TARGET 00012' },
        { id: 'visa-4', posted: recent(2), amount: -usd(15.49), description: 'NETFLIX.COM' },
        {
          id: 'visa-5',
          posted: recent(2),
          amount: -usd(38.91),
          description: 'THE HOME DEPOT #4421',
        },
        { id: 'visa-6', posted: recent(1), amount: -usd(14.62), description: 'CHIPOTLE 1721' },
      ],
    },
  ])
  // Entered after the bank's copy arrived, so the inbox offers to merge them.
  await api.createTransaction({
    accountId: visa.id,
    date: recent(0),
    payee: 'Chipotle lunch',
    categoryId: cat['Dining Out']!,
    amount: -usd(14.62),
    cleared: false,
  })

  // ---- investments -----------------------------------------------------------------------
  // The brokerage's opening balance was never assigned to a goal; give the house some of it.
  await api.moveUnits({
    accountId: brokerage.id,
    fromGoalId: null,
    toGoalId: house.id,
    date: today,
    amount: usd(5000),
  })
  // Price the 529's fund so shares × price matches its latest valuation.
  const owned = await api.getAccountInvestments(college.id)
  const fundShares = owned.goals.flatMap((g) => g.holdings).find((h) => h.id === index.id)?.shares
  if (fundShares) {
    await api.updateHolding(index.id, {
      price: Math.round(values.get(college.id)! / fundShares),
      priceDate: today,
    })
  }
  // Two people, linked as spouses so the plan counts both. Jessica is younger and retires
  // first, so Matt's contributions run longer and his age sets the date.
  await api.updateProfile(matt.id, {
    birthMonth: '1988-04',
    retirementAge: 65,
    monthlyContribution: usd(1100),
    annualIncome: usd(125000),
    incomeGrowth: 4,
    contributionFollowsRaises: true,
    socialSecurityMonthly: usd(2900),
    socialSecurityAge: 67,
  })
  await api.updateProfile(jessica.id, {
    birthMonth: '1990-09',
    retirementAge: 62,
    monthlyContribution: usd(800),
    annualIncome: usd(88000),
    incomeGrowth: 3,
    socialSecurityMonthly: usd(2100),
    socialSecurityAge: 67,
    pensionMonthly: usd(450),
    pensionAge: 62,
  })
  await api.linkProfiles({
    memberId: matt.id,
    relatedMemberId: jessica.id,
    relationship: 'spouse',
  })
  await api.setRetirementSettings({
    returnRate: 7,
    inflationRate: 3,
    withdrawalRate: 4,
    lookbackMonths: 12,
  })
  await api.createRetirementFixedItem({
    name: 'Health insurance before Medicare',
    annualAmount: usd(9600),
    startAge: 60,
    endAge: 65,
  })
  await api.createRetirementFixedItem({
    name: 'Travel in early retirement',
    annualAmount: usd(14000),
    startAge: 65,
    endAge: 75,
  })
  await api.createEducationPlan({
    name: 'Emma — state university',
    accountId: college.id,
    goalId: emma.id,
    targetAmount: usd(120000),
    targetMonth: shiftMonth(thisMonth, 118),
    monthlyContribution: usd(200),
  })
  await api.createEducationPlan({
    name: 'Noah — state university',
    targetAmount: usd(120000),
    targetMonth: shiftMonth(thisMonth, 154),
    monthlyContribution: 0,
  })

  // ---- bills -----------------------------------------------------------------------------
  const nextOn = (dayOfMonth: number) => {
    const here = `${thisMonth}-${pad(dayOfMonth)}`
    return here > today ? here : `${shiftMonth(thisMonth, 1)}-${pad(dayOfMonth)}`
  }
  const bills: Parameters<BudgetApi['createRecurring']>[0][] = [
    {
      payee: 'Mortgage',
      amount: -usd(2100),
      cadence: 'monthly',
      nextDate: nextOn(1),
      accountId: checking.id,
      categoryId: cat['Mortgage']!,
    },
    {
      payee: 'Austin Energy',
      amount: -usd(205),
      cadence: 'monthly',
      nextDate: nextOn(12),
      accountId: checking.id,
      categoryId: cat['Electric & Gas']!,
    },
    // Not yet marked paid: shows as past due.
    {
      payee: 'City Utilities',
      amount: -usd(88),
      cadence: 'monthly',
      nextDate: recent(2),
      accountId: checking.id,
      categoryId: cat['Water & Trash']!,
    },
    {
      payee: 'Google Fiber',
      amount: -usd(79.99),
      cadence: 'monthly',
      nextDate: nextOn(8),
      accountId: checking.id,
      categoryId: cat['Internet']!,
    },
    {
      payee: 'Mint Mobile',
      amount: -usd(128.4),
      cadence: 'monthly',
      nextDate: nextOn(22),
      accountId: visa.id,
      categoryId: cat['Phone']!,
    },
    {
      payee: 'State Farm',
      amount: -usd(494),
      cadence: 'quarterly',
      nextDate: addDays(today, 24),
      accountId: checking.id,
      categoryId: cat['Car Insurance']!,
    },
    {
      payee: 'Homeowners insurance',
      amount: -usd(1450),
      cadence: 'yearly',
      nextDate: addDays(today, 19),
      accountId: checking.id,
      categoryId: cat['Household Supplies']!,
    },
    {
      payee: 'Car registration',
      amount: -usd(210),
      cadence: 'yearly',
      nextDate: addDays(today, 61),
      accountId: checking.id,
      categoryId: cat['Car Maintenance']!,
    },
    {
      payee: 'Netflix',
      amount: -usd(15.49),
      cadence: 'monthly',
      nextDate: nextOn(18),
      accountId: visa.id,
      categoryId: cat['Subscriptions']!,
    },
    {
      payee: 'Acme Corp Payroll',
      amount: usd(2850),
      cadence: 'monthly',
      nextDate: nextOn(1),
      accountId: checking.id,
    },
    {
      payee: 'Acme Corp Payroll',
      amount: usd(2850),
      cadence: 'monthly',
      nextDate: nextOn(15),
      accountId: checking.id,
    },
    {
      payee: 'Northwind Health Payroll',
      amount: usd(1900),
      cadence: 'biweekly',
      nextDate: addDays(today, 13),
      accountId: checking.id,
    },
  ]
  for (const bill of bills) await api.createRecurring(bill)

  // The savings account is reconciled to the bank, which locks what has cleared.
  const status = await api.getReconciliation(emergencySavings.id)
  await api.reconcileAccount({
    accountId: emergencySavings.id,
    statementBalance: status.clearedBalance,
    date: addDays(today, -3),
  })
}
