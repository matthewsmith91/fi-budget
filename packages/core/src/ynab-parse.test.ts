import { describe, expect, it } from 'vitest'
import { parseBudget, parseRegister, parseYnabAmount, planRegister } from './ynab-parse.ts'

const HEADER =
  'Account,Flag,Date,Payee,Category Group/Category,Category Group,Category,Memo,Outflow,Inflow,Cleared'
const register = (...lines: string[]) => [HEADER, ...lines].join('\n')

describe('parseYnabAmount', () => {
  it('reads currency formats into cents', () => {
    expect(parseYnabAmount('$1,234.56')).toBe(123456)
    expect(parseYnabAmount('-$5.00')).toBe(-500)
    expect(parseYnabAmount('(5.05)')).toBe(-505)
    expect(parseYnabAmount('1.234,56 €')).toBe(123456)
    expect(parseYnabAmount('12,5')).toBe(1250)
    expect(parseYnabAmount('1,234')).toBe(123400)
    expect(parseYnabAmount('$0.00')).toBe(0)
    expect(parseYnabAmount('')).toBe(0)
    expect(parseYnabAmount('7')).toBe(700)
  })

  it('refuses what it cannot read', () => {
    expect(() => parseYnabAmount('1.2.3,4,5x')).toThrow()
    expect(() => parseYnabAmount('1.234')).toThrow(/Cannot read/)
  })
})

describe('parseRegister', () => {
  const row = (date: string) => `Checking,,${date},Shop,,,,,$1.00,$0.00,Cleared`

  it('detects month-first dates from a day over 12', () => {
    const r = parseRegister(register(row('10/15/2026'), row('01/02/2026')))
    expect(r.dateOrder).toBe('MDY')
    expect(r.ambiguousDates).toBe(false)
    expect(r.rows.map((x) => x.date)).toEqual(['2026-10-15', '2026-01-02'])
  })

  it('detects day-first dates', () => {
    const r = parseRegister(register(row('15/10/2026'), row('01/02/2026')))
    expect(r.dateOrder).toBe('DMY')
    expect(r.rows.map((x) => x.date)).toEqual(['2026-10-15', '2026-02-01'])
  })

  it('reads year-first dates written with slashes', () => {
    const r = parseRegister(register(row('2026/10/30'), row('2026/01/02')))
    expect(r.dateOrder).toBe('YMD')
    expect(r.ambiguousDates).toBe(false)
    expect(r.rows.map((x) => x.date)).toEqual(['2026-10-30', '2026-01-02'])
  })

  it('names the date when it cannot be read in the detected order', () => {
    expect(() => parseRegister(register(row('13/13/2026')))).toThrow(
      /Register line 2: .*not a date/,
    )
  })

  it('reads ISO dates, and flags dates that could be read either way', () => {
    expect(parseRegister(register(row('2026-10-15'))).dateOrder).toBe('YMD')
    const unsure = parseRegister(register(row('01/02/2026')))
    expect(unsure.ambiguousDates).toBe(true)
    expect(unsure.rows[0]!.date).toBe('2026-01-02')
    expect(parseRegister(register(row('01/02/2026')), 'DMY').rows[0]!.date).toBe('2026-02-01')
  })

  it('reads category, amount and cleared state', () => {
    const [a, b, c, d] = parseRegister(
      register(
        'Checking,,10/15/2026,Kroger,Everyday: Groceries,Everyday,Groceries,weekly,$12.50,$0.00,Reconciled',
        'Checking,,10/15/2026,Employer,Inflow: Ready to Assign,Inflow,Ready to Assign,,$0.00,"$3,000.00",Cleared',
        'Visa,,10/15/2026,Pay,Credit Card Payments: Visa,Credit Card Payments,Visa,,$1.00,$0.00,Uncleared',
        'Checking,,10/15/2026,Odd,Everyday: Groceries,,,,$1.00,$0.00,Uncleared',
      ).replace('Odd,Everyday: Groceries,,,', 'Odd,Everyday: Groceries,,,'),
    ).rows
    expect(a).toMatchObject({
      group: 'Everyday',
      category: 'Groceries',
      amount: -1250,
      cleared: 'reconciled',
      memo: 'weekly',
    })
    expect(b).toMatchObject({ group: null, category: null, amount: 300000, cleared: 'cleared' })
    expect(c).toMatchObject({ group: null, category: null, cleared: 'uncleared' })
    // only the combined column filled in
    expect(d).toMatchObject({ group: 'Everyday', category: 'Groceries' })
  })

  it('marks the lines YNAB put in the budget, which a tracking account never has', () => {
    const rows = parseRegister(
      register(
        'Checking,,10/15/2026,Kroger,Everyday: Groceries,Everyday,Groceries,,$12.50,$0.00,Cleared',
        'Checking,,10/15/2026,Employer,Inflow: Ready to Assign,Inflow,Ready to Assign,,$0.00,$3.00,Cleared',
        'Mortgage,,10/15/2026,Transfer : Checking,,,,,$0.00,$9.00,Cleared',
      ),
    ).rows
    expect(rows.map((r) => r.inBudget)).toEqual([true, true, false])
  })

  it('reads the older YNAB 4 column names', () => {
    const text =
      'Account,Flag,Check Number,Date,Payee,Category,Master Category,Sub Category,Memo,Outflow,Inflow,Cleared\n' +
      'Checking,,,2026-10-15,Kroger,Everyday: Groceries,Everyday,Groceries,,$5.00,$0.00,C'
    expect(parseRegister(text).rows[0]).toMatchObject({
      group: 'Everyday',
      category: 'Groceries',
      amount: -500,
      cleared: 'cleared',
    })
  })

  it('says what is wrong with a file that is not a register', () => {
    expect(() => parseRegister('a,b\n1,2')).toThrow(/Register\.csv/)
    expect(() => parseRegister('')).toThrow(/empty/)
    expect(() => parseRegister(register('Checking,,13/45/2026,X,,,,,$1,$0,C'))).toThrow(/line 2/)
  })
})

describe('parseBudget', () => {
  const head = 'Month,Category Group/Category,Category Group,Category,Budgeted,Activity,Available'

  it('reads the newer Plan.csv, whose Budgeted column is called Assigned', () => {
    const rows = parseBudget(
      [
        '\uFEFF"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"',
        '"Jan 2020","Monthly Bills: Electricity Bill","Monthly Bills","Electricity Bill",$243.63,-$122.63,$121.00',
      ].join('\n'),
    )
    expect(rows).toEqual([
      {
        month: '2020-01',
        group: 'Monthly Bills',
        category: 'Electricity Bill',
        budgeted: 24363,
        activity: -12263,
        available: 12100,
      },
    ])
  })

  it('reads months by name, number or ISO, and leaves out YNAB’s own groups', () => {
    const rows = parseBudget(
      [
        head,
        'October 2026,Everyday: Groceries,Everyday,Groceries,$400.00,-$180.50,$219.50',
        'Nov 2026,Everyday: Groceries,Everyday,Groceries,$0.00,$0.00,$219.50',
        '2026-12,Everyday: Groceries,Everyday,Groceries,$10.00,$0.00,$229.50',
        '01/2027,Everyday: Groceries,Everyday,Groceries,$0.00,$0.00,$229.50',
        'October 2026,Credit Card Payments: Visa,Credit Card Payments,Visa,$0.00,$40.00,$40.00',
        'October 2026,Inflow: Ready to Assign,Inflow,Ready to Assign,$0.00,$0.00,$0.00',
      ].join('\n'),
    )
    expect(rows.map((r) => r.month)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01'])
    expect(rows[0]).toEqual({
      month: '2026-10',
      group: 'Everyday',
      category: 'Groceries',
      budgeted: 40000,
      activity: -18050,
      available: 21950,
    })
  })

  it('refuses a file without months', () => {
    expect(() => parseBudget('a,b\n1,2')).toThrow(/Budget\.csv/)
  })
})

describe('planRegister', () => {
  const rows = (...lines: string[]) => parseRegister(register(...lines)).rows
  const plan = (...lines: string[]) => planRegister(rows(...lines))

  it('pairs the two sides of a transfer, whatever order the file lists them in', () => {
    const p = plan(
      'A,,10/15/2026,Transfer : B,,,,,$5.00,$0.00,Cleared',
      'B,,10/15/2026,Transfer : A,,,,,$0.00,$5.00,Cleared',
      'B,,10/16/2026,Transfer : A,,,,,$7.00,$0.00,Cleared',
      'A,,10/16/2026,Transfer : B,,,,,$0.00,$7.00,Cleared',
    )
    expect(p.items.map((i) => i.kind)).toEqual(['transfer', 'transfer'])
    expect(p.unpairedTransfers).toBe(0)
  })

  it('pairs repeated identical transfers one to one', () => {
    const p = plan(
      'A,,10/15/2026,Transfer : B,,,,,$5.00,$0.00,C',
      'A,,10/15/2026,Transfer : B,,,,,$5.00,$0.00,C',
      'B,,10/15/2026,Transfer : A,,,,,$0.00,$5.00,C',
      'B,,10/15/2026,Transfer : A,,,,,$0.00,$5.00,C',
    )
    expect(p.items.map((i) => i.kind)).toEqual(['transfer', 'transfer'])
  })

  it('keeps a transfer with no other side as a plain transaction and counts it', () => {
    const p = plan('A,,10/15/2026,Transfer : Gone,,,,,$5.00,$0.00,C')
    expect(p.items.map((i) => i.kind)).toEqual(['transaction'])
    expect(p.unpairedTransfers).toBe(1)
  })

  it('joins split lines into one transaction', () => {
    const p = plan(
      'A,,10/15/2026,Costco,Food: Groceries,Food,Groceries,(Split 1/2) a,$60.00,$0.00,C',
      'A,,10/15/2026,Costco,Home: Supplies,Home,Supplies,(Split 2/2) b,$40.00,$0.00,C',
      'A,,10/16/2026,Other,,,,,$1.00,$0.00,C',
    )
    expect(p.items.map((i) => i.kind)).toEqual(['split', 'transaction'])
  })

  it('does not join split lines that belong to different transactions, and counts the strays', () => {
    const p = plan(
      'A,,10/15/2026,Costco,Food: Groceries,Food,Groceries,(Split 1/2) a,$60.00,$0.00,C',
      'A,,10/16/2026,Costco,Home: Supplies,Home,Supplies,(Split 2/2) b,$40.00,$0.00,C',
    )
    expect(p.items.map((i) => i.kind)).toEqual(['transaction', 'transaction'])
    expect(p.brokenSplits).toBe(2)
  })

  it('skips lines with no amount', () => {
    const p = plan('A,,10/15/2026,Nothing,,,,,$0.00,$0.00,C')
    expect(p.items).toEqual([])
    expect(p.skippedZero).toBe(1)
  })
})
