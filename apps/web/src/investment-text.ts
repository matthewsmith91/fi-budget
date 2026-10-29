import { money } from './format.ts'

/** `+$300.00` for a gain, `-$12.00` for a loss, `$0.00` for neither. */
export function gainText(gain: number): string {
  return gain > 0 ? `+${money(gain)}` : money(gain)
}

/** Units or shares to up to four decimals, without trailing zeros: `500`, `12.5`, `0.0125`. */
export function unitsText(units: number): string {
  return units.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

/** A price in cents (which may carry fractions) as dollars with at least two decimals: `$212.34`, `$1.2346`. */
export function priceText(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

/**
 * Dollars typed for a price (`212.34`, `$1,234.5678`) as cents, keeping up to four decimals
 * because funds are priced finer than a cent. Null when it isn't a positive number.
 */
export function parsePrice(text: string): number | null {
  const typed = text.trim().replace(/^\$/, '')
  if (typed.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(typed)) return null
  const t = typed.replaceAll(',', '')
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return null
  const dollars = Number(t)
  if (!(dollars > 0)) return null
  // Scale in integers: 4 decimals of a dollar is hundredths of a cent.
  const [whole, frac = ''] = t.split('.')
  return (Number(whole) * 10_000 + Number(frac.padEnd(4, '0'))) / 100
}

/** Shares typed with up to six decimals; null when it isn't a positive number. */
export function parseShares(text: string): number | null {
  const t = text.trim().replaceAll(',', '')
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null
  const shares = Number(t)
  return shares > 0 ? shares : null
}
