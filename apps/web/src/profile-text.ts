import {
  DEFAULT_PROFILE_SETTINGS,
  parseCents,
  type Profile,
  type ProfileSettings,
} from '@budget-fi/core'

/** What the profile form edits, as text the way it is typed. */
export interface ProfileForm {
  displayName: string
  birthMonth: string
  retirementAge: string
  monthlyContribution: string
  annualIncome: string
  incomeGrowth: string
  contributionFollowsRaises: boolean
  socialSecurityMonthly: string
  socialSecurityAge: string
  pensionMonthly: string
  pensionAge: string
}

/** Dollars as typed, empty for none. */
const dollars = (cents: number) => (cents === 0 ? '' : (cents / 100).toFixed(2))

export const profileFormOf = (p: Profile | null): ProfileForm => {
  const s = p ?? DEFAULT_PROFILE_SETTINGS
  return {
    displayName: p?.displayName ?? '',
    birthMonth: s.birthMonth ?? '',
    retirementAge: String(s.retirementAge),
    monthlyContribution: dollars(s.monthlyContribution),
    annualIncome: dollars(s.annualIncome),
    incomeGrowth: String(s.incomeGrowth),
    contributionFollowsRaises: s.contributionFollowsRaises,
    socialSecurityMonthly: dollars(s.socialSecurityMonthly),
    socialSecurityAge: String(s.socialSecurityAge),
    pensionMonthly: dollars(s.pensionMonthly),
    pensionAge: String(s.pensionAge),
  }
}

/** The form's text as a profile's settings, or what to fix. */
export function parseProfileForm(
  form: ProfileForm,
): { ok: true; input: ProfileSettings & { displayName: string } } | { ok: false; error: string } {
  if (form.displayName.trim() === '') return { ok: false, error: 'Enter a name' }
  type Cents = { ok: true; cents: number } | { ok: false; error: string }
  const money = (text: string, what: string): Cents => {
    const cents = text.trim() === '' ? 0 : parseCents(text)
    return cents === null || cents < 0
      ? { ok: false, error: `Enter ${what} as dollars, like 1,500.00` }
      : { ok: true, cents }
  }
  const number = (text: string) => (text.trim() === '' ? NaN : Number(text))

  const contribution = money(form.monthlyContribution, 'the monthly contribution')
  if (!contribution.ok) return contribution
  const income = money(form.annualIncome, 'the yearly income')
  if (!income.ok) return income
  const socialSecurity = money(form.socialSecurityMonthly, 'the Social Security amount')
  if (!socialSecurity.ok) return socialSecurity
  const pension = money(form.pensionMonthly, 'the pension amount')
  if (!pension.ok) return pension

  const retirementAge = number(form.retirementAge)
  if (!Number.isInteger(retirementAge)) {
    return { ok: false, error: 'Enter the retirement age in whole years' }
  }
  const incomeGrowth = number(form.incomeGrowth)
  if (!Number.isFinite(incomeGrowth)) {
    return { ok: false, error: 'Enter the yearly raise as a percent, like 3' }
  }
  const socialSecurityAge = number(form.socialSecurityAge)
  if (!Number.isInteger(socialSecurityAge)) {
    return { ok: false, error: 'Enter the Social Security age in whole years' }
  }
  const pensionAge = number(form.pensionAge)
  if (!Number.isInteger(pensionAge)) {
    return { ok: false, error: 'Enter the pension age in whole years' }
  }
  return {
    ok: true,
    input: {
      displayName: form.displayName.trim(),
      birthMonth: form.birthMonth === '' ? null : form.birthMonth,
      retirementAge,
      monthlyContribution: contribution.cents,
      annualIncome: income.cents,
      incomeGrowth,
      contributionFollowsRaises: form.contributionFollowsRaises,
      socialSecurityMonthly: socialSecurity.cents,
      socialSecurityAge,
      pensionMonthly: pension.cents,
      pensionAge,
    },
  }
}

/** What share of income goes into retirement accounts, in whole percent; null with no income. */
export function savingsRate(monthlyContribution: number, annualIncome: number): number | null {
  return annualIncome > 0 ? Math.round((monthlyContribution * 1200) / annualIncome) : null
}
