import {
  parseCents,
  type EducationPlan,
  type EducationPlanInput,
  type RecurringCadence,
  type RecurringInput,
  type RecurringItem,
  type RetirementFixedItem,
  type RetirementFixedItemInput,
} from '@budget-fi/core'

type Parsed<T> = { ok: true; input: T } | { ok: false; error: string }

/** Blank text is "not given"; anything else must be a whole number of years. */
function optionalWhole(text: string): number | null | undefined {
  if (text.trim() === '') return null
  const n = Number(text)
  return Number.isInteger(n) ? n : undefined
}

/** When a fixed item applies, for a list: `until 65`, `from 60`, `ages 60 to 65`. */
export function ageWindow(startAge: number | null, endAge: number | null): string {
  if (startAge !== null && endAge !== null) return `ages ${startAge} to ${endAge}`
  if (endAge !== null) return `until ${endAge}`
  if (startAge !== null) return `from ${startAge}`
  return 'all of retirement'
}

export interface FixedItemForm {
  name: string
  annualAmount: string
  startAge: string
  endAge: string
}

export const emptyFixedItemForm: FixedItemForm = {
  name: '',
  annualAmount: '',
  startAge: '',
  endAge: '',
}

export const fixedItemFormOf = (item: RetirementFixedItem): FixedItemForm => ({
  name: item.name,
  annualAmount: (item.annualAmount / 100).toFixed(2),
  startAge: item.startAge === null ? '' : String(item.startAge),
  endAge: item.endAge === null ? '' : String(item.endAge),
})

export function parseFixedItemForm(form: FixedItemForm): Parsed<RetirementFixedItemInput> {
  if (form.name.trim() === '') return { ok: false, error: 'Name the cost, like Health insurance' }
  const annualAmount = parseCents(form.annualAmount)
  if (annualAmount === null || annualAmount <= 0) {
    return { ok: false, error: 'Enter the yearly cost in dollars, like 12,000.00' }
  }
  const startAge = optionalWhole(form.startAge)
  const endAge = optionalWhole(form.endAge)
  if (startAge === undefined) return { ok: false, error: 'Enter the start age in whole years' }
  if (endAge === undefined) return { ok: false, error: 'Enter the end age in whole years' }
  return { ok: true, input: { name: form.name, annualAmount, startAge, endAge } }
}

export interface EducationForm {
  name: string
  accountId: string
  goalId: string
  targetAmount: string
  targetMonth: string
  monthlyContribution: string
  returnRate: string
  inflationRate: string
}

export const emptyEducationForm: EducationForm = {
  name: '',
  accountId: '',
  goalId: '',
  targetAmount: '',
  targetMonth: '',
  monthlyContribution: '',
  returnRate: '6',
  inflationRate: '4',
}

export const educationFormOf = (plan: EducationPlan): EducationForm => ({
  name: plan.name,
  accountId: plan.accountId ?? '',
  goalId: plan.goalId ?? '',
  targetAmount: (plan.targetAmount / 100).toFixed(2),
  targetMonth: plan.targetMonth,
  monthlyContribution:
    plan.monthlyContribution === 0 ? '' : (plan.monthlyContribution / 100).toFixed(2),
  returnRate: String(plan.returnRate),
  inflationRate: String(plan.inflationRate),
})

export function parseEducationForm(form: EducationForm): Parsed<EducationPlanInput> {
  if (form.name.trim() === '') return { ok: false, error: 'Name the plan, like the child’s name' }
  const targetAmount = parseCents(form.targetAmount)
  if (targetAmount === null || targetAmount <= 0) {
    return { ok: false, error: 'Enter what it costs in today’s prices, like 80,000.00' }
  }
  if (!/^\d{4}-\d{2}$/.test(form.targetMonth)) {
    return { ok: false, error: 'Pick the month the money is needed' }
  }
  const monthlyContribution =
    form.monthlyContribution.trim() === '' ? 0 : parseCents(form.monthlyContribution)
  if (monthlyContribution === null || monthlyContribution < 0) {
    return { ok: false, error: 'Enter the monthly contribution as dollars, like 250.00' }
  }
  const returnRate = form.returnRate.trim() === '' ? NaN : Number(form.returnRate)
  if (!Number.isFinite(returnRate))
    return { ok: false, error: 'Enter the return as a percent, like 6' }
  const inflationRate = form.inflationRate.trim() === '' ? NaN : Number(form.inflationRate)
  if (!Number.isFinite(inflationRate)) {
    return { ok: false, error: 'Enter the yearly rise in costs as a percent, like 4' }
  }
  return {
    ok: true,
    input: {
      name: form.name,
      accountId: form.accountId || null,
      goalId: form.accountId && form.goalId ? form.goalId : null,
      targetAmount,
      targetMonth: form.targetMonth,
      monthlyContribution,
      returnRate,
      inflationRate,
    },
  }
}

export const CADENCE_LABELS: Record<RecurringCadence, string> = {
  weekly: 'Every week',
  biweekly: 'Every 2 weeks',
  monthly: 'Every month',
  quarterly: 'Every 3 months',
  yearly: 'Every year',
}

export interface RecurringForm {
  payee: string
  kind: 'bill' | 'income'
  amount: string
  cadence: RecurringCadence
  nextDate: string
  categoryId: string
  accountId: string
}

export const emptyRecurringForm: RecurringForm = {
  payee: '',
  kind: 'bill',
  amount: '',
  cadence: 'monthly',
  nextDate: '',
  categoryId: '',
  accountId: '',
}

export const recurringFormOf = (item: RecurringItem): RecurringForm => ({
  payee: item.payee,
  kind: item.amount < 0 ? 'bill' : 'income',
  amount: (Math.abs(item.amount) / 100).toFixed(2),
  cadence: item.cadence,
  nextDate: item.nextDate,
  categoryId: item.categoryId ?? '',
  accountId: item.accountId ?? '',
})

export function parseRecurringForm(form: RecurringForm): Parsed<RecurringInput> {
  if (form.payee.trim() === '') return { ok: false, error: 'Enter who it is paid to, or by' }
  const amount = parseCents(form.amount)
  if (amount === null || amount <= 0) {
    return { ok: false, error: 'Enter the amount in dollars, like 1,500.00' }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.nextDate)) {
    return { ok: false, error: 'Pick the date it is next due' }
  }
  return {
    ok: true,
    input: {
      payee: form.payee,
      amount: form.kind === 'bill' ? -amount : amount,
      cadence: form.cadence,
      nextDate: form.nextDate,
      categoryId: form.categoryId || null,
      accountId: form.accountId || null,
    },
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** Day of the week, 0 for Sunday. */
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()

/** `2026-11-01` as `Sun, Nov 1`. */
export function dayLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number]
  return `${WEEKDAYS[weekdayOf(date)]}, ${SHORT_MONTHS[m - 1]} ${d}`
}

/** `2026-11-01` as `11/1`, for a chart's axis. */
export const dayShort = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`

/**
 * Pure: the cells of a month grid that starts on Sunday: blanks (null) before the 1st, then
 * each day as `YYYY-MM-DD`, then blanks to fill the last week.
 */
export function monthGrid(month: string): (string | null)[] {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const lead = weekdayOf(`${month}-01`)
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const cells: (string | null)[] = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}
