import { describe, expect, it } from 'vitest'
import {
  ageLabel,
  monthYear,
  parseRetirementForm,
  retirementFormOf,
  retirementTag,
  timeUntil,
} from './retirement-text.ts'

describe('retirement text', () => {
  it('labels ages', () => {
    expect(ageLabel(35)).toBe('35')
    expect(ageLabel(35.5)).toBe('35.5')
    expect(ageLabel(35.08)).toBe('35.1')
  })

  it('says how long is left', () => {
    expect(timeUntil(0)).toBe('now')
    expect(timeUntil(1)).toBe('1 month')
    expect(timeUntil(12)).toBe('1 year')
    expect(timeUntil(27)).toBe('2 years, 3 months')
  })

  it('names months', () => {
    expect(monthYear('2036-10')).toBe('Oct 2036')
  })

  it('tags only categories that don’t simply continue', () => {
    expect(retirementTag('continues', null)).toBeNull()
    expect(retirementTag('ends', null)).toBe('Ends')
    expect(retirementTag('changes', 1.5)).toBe('×1.5')
    expect(retirementTag('changes', null)).toBe('×1')
  })

  describe('the settings form', () => {
    const form = { returnRate: '6.5', inflationRate: '2.5' }

    it('reads the text as settings', () => {
      expect(parseRetirementForm(form)).toEqual({
        ok: true,
        settings: { returnRate: 6.5, inflationRate: 2.5 },
      })
    })

    it('says what is wrong', () => {
      expect(parseRetirementForm({ ...form, returnRate: '' })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/return/),
      })
      expect(parseRetirementForm({ ...form, inflationRate: 'x' })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/inflation/i),
      })
    })

    it('round-trips through the form', () => {
      const settings = { returnRate: 7, inflationRate: 3 }
      expect(parseRetirementForm(retirementFormOf(settings))).toEqual({ ok: true, settings })
    })
  })
})
