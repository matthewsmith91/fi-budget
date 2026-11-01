import { DEFAULT_PROFILE_SETTINGS, type Profile } from '@budget-fi/core'
import { describe, expect, it } from 'vitest'
import { parseProfileForm, profileFormOf, savingsRate } from './profile-text.ts'

const profile: Profile = {
  ...DEFAULT_PROFILE_SETTINGS,
  id: 'p',
  displayName: 'Jessica',
  birthMonth: '1990-09',
  retirementAge: 62,
  monthlyContribution: 800_00,
  annualIncome: 88_000_00,
  incomeGrowth: 3.5,
  contributionFollowsRaises: true,
  socialSecurityMonthly: 2_100_00,
  pensionMonthly: 450_00,
  pensionAge: 62,
  links: [],
  plan: { included: true, note: null },
}

describe('the profile form', () => {
  it('shows a profile as text, leaving empty what is zero', () => {
    expect(profileFormOf(profile)).toEqual({
      displayName: 'Jessica',
      birthMonth: '1990-09',
      retirementAge: '62',
      monthlyContribution: '800.00',
      annualIncome: '88000.00',
      incomeGrowth: '3.5',
      contributionFollowsRaises: true,
      socialSecurityMonthly: '2100.00',
      socialSecurityAge: '67',
      pensionMonthly: '450.00',
      pensionAge: '62',
    })
    expect(profileFormOf(null)).toMatchObject({
      displayName: '',
      birthMonth: '',
      retirementAge: '65',
      monthlyContribution: '',
      incomeGrowth: '3',
    })
  })

  it('reads its own text back unchanged', () => {
    const parsed = parseProfileForm(profileFormOf(profile))
    expect(parsed).toEqual({
      ok: true,
      input: {
        displayName: 'Jessica',
        birthMonth: '1990-09',
        retirementAge: 62,
        monthlyContribution: 800_00,
        annualIncome: 88_000_00,
        incomeGrowth: 3.5,
        contributionFollowsRaises: true,
        socialSecurityMonthly: 2_100_00,
        socialSecurityAge: 67,
        pensionMonthly: 450_00,
        pensionAge: 62,
      },
    })
  })

  it('takes blanks as zero money and no birth month', () => {
    const parsed = parseProfileForm({
      ...profileFormOf(null),
      displayName: ' Sam ',
      annualIncome: '55,000',
    })
    expect(parsed).toMatchObject({
      ok: true,
      input: {
        displayName: 'Sam',
        birthMonth: null,
        annualIncome: 55_000_00,
        monthlyContribution: 0,
      },
    })
  })

  it('says what is wrong', () => {
    const form = profileFormOf(profile)
    const error = (patch: Partial<typeof form>) => {
      const r = parseProfileForm({ ...form, ...patch })
      return r.ok ? null : r.error
    }
    expect(error({ displayName: ' ' })).toMatch(/name/)
    expect(error({ monthlyContribution: 'lots' })).toMatch(/monthly contribution/)
    expect(error({ annualIncome: '-5' })).toMatch(/income/)
    expect(error({ socialSecurityMonthly: 'x' })).toMatch(/Social Security amount/)
    expect(error({ pensionMonthly: 'x' })).toMatch(/pension amount/)
    expect(error({ retirementAge: '' })).toMatch(/retirement age/)
    expect(error({ retirementAge: '65.5' })).toMatch(/retirement age/)
    expect(error({ incomeGrowth: '' })).toMatch(/raise/)
    expect(error({ socialSecurityAge: '6x' })).toMatch(/Social Security age/)
    expect(error({ pensionAge: '' })).toMatch(/pension age/)
  })

  it('works out what share of income is saved', () => {
    expect(savingsRate(800_00, 88_000_00)).toBe(11)
    expect(savingsRate(800_00, 0)).toBeNull()
  })
})
