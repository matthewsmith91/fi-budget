import { describe, expect, it } from 'vitest'
import { gainText, parsePrice, parseShares, priceText, unitsText } from './investment-text.ts'

describe('gainText', () => {
  it('signs a gain, and leaves a loss and zero to the money format', () => {
    expect(gainText(30_000)).toBe('+$300.00')
    expect(gainText(-1_200)).toBe('-$12.00')
    expect(gainText(0)).toBe('$0.00')
  })
})

describe('unitsText and priceText', () => {
  it('trims zeros from units and keeps fractions of a cent in a price', () => {
    expect(unitsText(500)).toBe('500')
    expect(unitsText(12.5)).toBe('12.5')
    expect(unitsText(0.01234567)).toBe('0.0123')
    expect(priceText(100)).toBe('$1.00')
    expect(priceText(21_234)).toBe('$212.34')
    expect(priceText(123.46)).toBe('$1.2346')
  })
})

describe('parsePrice', () => {
  it('reads dollars into cents, keeping up to four decimals', () => {
    expect(parsePrice('212.34')).toBe(21_234)
    expect(parsePrice('$1,234.5')).toBe(123_450)
    expect(parsePrice('1.2346')).toBe(123.46)
  })

  it('refuses what is not a positive price', () => {
    for (const bad of ['', '0', '-3', 'abc', '1.23456', '1,2', '0.00']) {
      expect(parsePrice(bad), bad).toBeNull()
    }
  })
})

describe('parseShares', () => {
  it('reads positive shares to six decimals', () => {
    expect(parseShares('12.5')).toBe(12.5)
    expect(parseShares('0.000001')).toBe(0.000001)
    expect(parseShares('0')).toBeNull()
    expect(parseShares('1.2345678')).toBeNull()
    expect(parseShares('x')).toBeNull()
  })
})
