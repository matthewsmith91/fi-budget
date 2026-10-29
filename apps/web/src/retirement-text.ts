import { parseCents, type RetirementSettings, type RetirementStatus } from '@budget-fi/core'
import { monthLabel } from './format.ts'

/** `35`, `35.5`; the projection's ages come in hundredths. */
export const ageLabel = (age: number) => (Number.isInteger(age) ? String(age) : age.toFixed(1))

/** `12 years, 3 months`; `now` when there is none left. */
export function timeUntil(months: number): string {
  if (months <= 0) return 'now'
  const years = Math.floor(months / 12)
  const rest = months % 12
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  return [years > 0 && part(years, 'year'), rest > 0 && part(rest, 'month')]
    .filter(Boolean)
    .join(', ')
}

/** `2036-10` as `Oct 2036`. */
export function monthYear(month: string): string {
  const { name, year } = monthLabel(month)
  return `${name.slice(0, 3)} ${year}`
}

/** What a category does in retirement, for the tag beside its name; null when it continues. */
export function retirementTag(status: RetirementStatus, multiplier: number | null): string | null {
  if (status === 'ends') return 'Ends'
  if (status === 'changes') return `×${multiplier ?? 1}`
  return null
}

export const RETIREMENT_STATUS_LABELS: Record<RetirementStatus, string> = {
  continues: 'Continues',
  ends: 'Ends',
  changes: 'Changes',
}

/** The assumptions the retirement form edits; the withdrawal rate and lookback live with spending. */
export type RetirementBasics = Omit<RetirementSettings, 'withdrawalRate' | 'lookbackMonths'>

export interface RetirementForm {
  birthMonth: string
  targetAge: string
  monthlyContribution: string
  returnRate: string
  inflationRate: string
}

/** The form's text as settings, or what's wrong with it. */
export function parseRetirementForm(
  form: RetirementForm,
): { ok: true; settings: RetirementBasics } | { ok: false; error: string } {
  const monthlyContribution =
    form.monthlyContribution.trim() === '' ? 0 : parseCents(form.monthlyContribution)
  if (monthlyContribution === null || monthlyContribution < 0) {
    return { ok: false, error: 'Enter the monthly contribution as dollars, like 1,500.00' }
  }
  const number = (text: string) => (text.trim() === '' ? NaN : Number(text))
  const targetAge = number(form.targetAge)
  if (!Number.isInteger(targetAge))
    return { ok: false, error: 'Enter the target age in whole years' }
  const returnRate = number(form.returnRate)
  if (!Number.isFinite(returnRate))
    return { ok: false, error: 'Enter the yearly return as a percent, like 7' }
  const inflationRate = number(form.inflationRate)
  if (!Number.isFinite(inflationRate))
    return { ok: false, error: 'Enter inflation as a percent, like 3' }
  return {
    ok: true,
    settings: {
      birthMonth: form.birthMonth === '' ? null : form.birthMonth,
      targetAge,
      monthlyContribution,
      returnRate,
      inflationRate,
    },
  }
}

export const retirementFormOf = (s: RetirementBasics): RetirementForm => ({
  birthMonth: s.birthMonth ?? '',
  targetAge: String(s.targetAge),
  monthlyContribution: s.monthlyContribution === 0 ? '' : (s.monthlyContribution / 100).toFixed(2),
  returnRate: String(s.returnRate),
  inflationRate: String(s.inflationRate),
})
