import { describe, expect, it } from 'vitest'
import {
  ageWindow,
  dayLabel,
  dayShort,
  educationFormOf,
  emptyEducationForm,
  emptyFixedItemForm,
  emptyRecurringForm,
  fixedItemFormOf,
  monthGrid,
  parseEducationForm,
  parseFixedItemForm,
  parseRecurringForm,
  recurringFormOf,
} from './planning-text.ts'

describe('ageWindow', () => {
  it('describes each way a fixed item can apply', () => {
    expect(ageWindow(null, null)).toBe('all of retirement')
    expect(ageWindow(null, 65)).toBe('until 65')
    expect(ageWindow(60, null)).toBe('from 60')
    expect(ageWindow(60, 65)).toBe('ages 60 to 65')
  })
})

describe('the fixed item form', () => {
  const form = { name: ' Health insurance ', annualAmount: '12,000', startAge: '', endAge: '65' }

  it('reads dollars and optional ages', () => {
    expect(parseFixedItemForm(form)).toEqual({
      ok: true,
      input: { name: ' Health insurance ', annualAmount: 1_200_000, startAge: null, endAge: 65 },
    })
  })

  it('says what is wrong', () => {
    const bad = (patch: Partial<typeof form>) => {
      const r = parseFixedItemForm({ ...form, ...patch })
      return r.ok ? null : r.error
    }
    expect(bad({ name: ' ' })).toMatch(/Name the cost/)
    expect(bad({ annualAmount: '' })).toMatch(/yearly cost/)
    expect(bad({ annualAmount: '0' })).toMatch(/yearly cost/)
    expect(bad({ annualAmount: '12,00' })).toMatch(/yearly cost/)
    expect(bad({ startAge: '60.5' })).toMatch(/start age/)
    expect(bad({ endAge: 'x' })).toMatch(/end age/)
  })

  it('round-trips through the form', () => {
    const item = { id: 'i', name: 'Care', annualAmount: 123_456, startAge: 70, endAge: null }
    const result = parseFixedItemForm(fixedItemFormOf(item))
    expect(result).toEqual({
      ok: true,
      input: { name: 'Care', annualAmount: 123_456, startAge: 70, endAge: null },
    })
    expect(parseFixedItemForm(emptyFixedItemForm).ok).toBe(false)
  })
})

describe('the education form', () => {
  const form = {
    name: 'Emma',
    accountId: 'a',
    goalId: 'g',
    targetAmount: '80,000',
    targetMonth: '2036-08',
    monthlyContribution: '250',
    returnRate: '6',
    inflationRate: '4',
  }

  it('reads the plan', () => {
    expect(parseEducationForm(form)).toEqual({
      ok: true,
      input: {
        name: 'Emma',
        accountId: 'a',
        goalId: 'g',
        targetAmount: 8_000_000,
        targetMonth: '2036-08',
        monthlyContribution: 25_000,
        returnRate: 6,
        inflationRate: 4,
      },
    })
  })

  it('treats a blank contribution as none and drops a goal that has no account', () => {
    const r = parseEducationForm({ ...form, monthlyContribution: '', accountId: '' })
    expect(r).toMatchObject({
      ok: true,
      input: { monthlyContribution: 0, accountId: null, goalId: null },
    })
  })

  it('says what is wrong', () => {
    const bad = (patch: Partial<typeof form>) => {
      const r = parseEducationForm({ ...form, ...patch })
      return r.ok ? null : r.error
    }
    expect(bad({ name: '' })).toMatch(/Name the plan/)
    expect(bad({ targetAmount: '-1' })).toMatch(/costs/)
    expect(bad({ targetMonth: '' })).toMatch(/month/)
    expect(bad({ monthlyContribution: 'lots' })).toMatch(/contribution/)
    expect(bad({ returnRate: '' })).toMatch(/return/)
    expect(bad({ inflationRate: 'x' })).toMatch(/rise in costs/)
    expect(parseEducationForm(emptyEducationForm).ok).toBe(false)
  })

  it('round-trips through the form', () => {
    const plan = {
      id: 'p',
      name: 'Noah',
      accountId: null,
      goalId: null,
      targetAmount: 5_000_000,
      targetMonth: '2038-08',
      monthlyContribution: 0,
      returnRate: 5.5,
      inflationRate: 3,
    }
    expect(parseEducationForm(educationFormOf(plan))).toEqual({
      ok: true,
      input: {
        name: 'Noah',
        accountId: null,
        goalId: null,
        targetAmount: 5_000_000,
        targetMonth: '2038-08',
        monthlyContribution: 0,
        returnRate: 5.5,
        inflationRate: 3,
      },
    })
  })
})

describe('the recurring form', () => {
  const form = {
    payee: 'Landlord',
    kind: 'bill' as const,
    amount: '1,500',
    cadence: 'monthly' as const,
    nextDate: '2026-11-01',
    categoryId: 'c',
    accountId: '',
  }

  it('makes a bill negative and income positive', () => {
    expect(parseRecurringForm(form)).toEqual({
      ok: true,
      input: {
        payee: 'Landlord',
        amount: -150_000,
        cadence: 'monthly',
        nextDate: '2026-11-01',
        categoryId: 'c',
        accountId: null,
      },
    })
    expect(parseRecurringForm({ ...form, kind: 'income' })).toMatchObject({
      input: { amount: 150_000 },
    })
  })

  it('says what is wrong', () => {
    const bad = (patch: Partial<typeof form>) => {
      const r = parseRecurringForm({ ...form, ...patch })
      return r.ok ? null : r.error
    }
    expect(bad({ payee: ' ' })).toMatch(/paid to/)
    expect(bad({ amount: '0' })).toMatch(/amount/)
    expect(bad({ amount: '' })).toMatch(/amount/)
    expect(bad({ nextDate: '' })).toMatch(/next due/)
    expect(parseRecurringForm(emptyRecurringForm).ok).toBe(false)
  })

  it('round-trips through the form, signs included', () => {
    const item = {
      id: 'r',
      payee: 'Paycheck',
      amount: 250_000,
      cadence: 'biweekly' as const,
      nextDate: '2026-11-06',
      categoryId: null,
      accountId: 'a',
    }
    expect(recurringFormOf(item)).toMatchObject({ kind: 'income', amount: '2500.00' })
    expect(parseRecurringForm(recurringFormOf(item))).toMatchObject({
      ok: true,
      input: { amount: 250_000, accountId: 'a', categoryId: null },
    })
    expect(recurringFormOf({ ...item, amount: -9_999 })).toMatchObject({
      kind: 'bill',
      amount: '99.99',
    })
  })
})

describe('dates', () => {
  it('labels a day with its weekday', () => {
    expect(dayLabel('2026-11-01')).toBe('Sun, Nov 1')
    expect(dayLabel('2026-12-25')).toBe('Fri, Dec 25')
    expect(dayShort('2026-11-01')).toBe('11/1')
  })

  it('lays a month out in weeks starting on Sunday', () => {
    const nov = monthGrid('2026-11')
    expect(nov).toHaveLength(35)
    expect(nov[0]).toBe('2026-11-01')
    expect(nov[29]).toBe('2026-11-30')
    expect(nov.slice(30)).toEqual([null, null, null, null, null])
    // October 2026 starts on a Thursday
    const oct = monthGrid('2026-10')
    expect(oct.slice(0, 5)).toEqual([null, null, null, null, '2026-10-01'])
    expect(oct).toHaveLength(35)
    expect(monthGrid('2026-02')).toHaveLength(28)
  })
})
