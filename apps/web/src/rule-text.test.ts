import { describe, expect, it } from 'vitest'
import { ruleTextFor } from './rule-text.ts'

describe('ruleTextFor', () => {
  it('keeps the words before the first store number', () => {
    expect(ruleTextFor('KROGER #123 ATLANTA GA')).toBe('KROGER')
    expect(ruleTextFor('Trader Joes 0543')).toBe('Trader Joes')
    expect(ruleTextFor('AMAZON.COM*AB12CD')).toBe('AMAZON COM')
  })

  it('keeps at most three words', () => {
    expect(ruleTextFor('The Home Depot Store Online')).toBe('The Home Depot')
  })

  it('falls back to the whole payee when every word has a digit', () => {
    expect(ruleTextFor('7-ELEVEN 1234')).toBe('7-ELEVEN 1234')
  })
})
