/** Money is integer cents everywhere. Never use floats for amounts. */
export type Cents = number & { readonly __brand: 'Cents' }

export function cents(n: number): Cents {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`Cents must be a safe integer, got ${n}`)
  }
  return n as Cents
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0
  for (const v of values) total += v
  return cents(total)
}

const AMOUNT = /^(\d+)?(?:\.(\d{1,2}))?$/

/**
 * Parses user-entered dollars ("$1,234.50", "-5.05", "(5.05)") into cents using
 * string arithmetic only. Returns null for anything ambiguous (e.g. 3 decimals).
 */
export function parseCents(input: string): Cents | null {
  let s = input.trim()
  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true
    s = s.slice(1, -1).trim()
  }
  if (s.startsWith('-')) {
    if (negative) return null
    negative = true
    s = s.slice(1).trim()
  }
  if (s.startsWith('$')) s = s.slice(1)
  if (/,/.test(s) && !/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(s)) return null
  s = s.replaceAll(',', '')
  if (s === '' || s === '.') return null
  const m = AMOUNT.exec(s)
  if (!m) return null
  const whole = m[1] ?? '0'
  const frac = (m[2] ?? '').padEnd(2, '0')
  const value = Number(whole) * 100 + Number(frac)
  if (!Number.isSafeInteger(value)) return null
  return cents(negative ? -value : value)
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const plain = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Formats cents for display. The division happens only at the display edge. */
export function formatCents(value: Cents, opts: { symbol?: boolean } = {}): string {
  const fmt = opts.symbol === false ? plain : usd
  return fmt.format(value / 100)
}

/**
 * `pct` percent of `total`, rounded half away from zero to the cent. The
 * remainder (total - amount) is returned so callers can send it to Ready to Assign.
 */
export function percentOf(total: Cents, pct: number): { amount: Cents; remainder: Cents } {
  if (!(pct >= 0 && pct <= 100)) throw new RangeError(`Percent out of range: ${pct}`)
  const sign = total < 0 ? -1 : 1
  const abs = Math.abs(total)
  // abs * pct can be fractional only through pct; use thousandths to stay exact for
  // percents with up to 3 decimals, then round half up on the integer result.
  const scaled = abs * Math.round(pct * 1000)
  const amount = sign * Math.floor((scaled + 50_000) / 100_000)
  return { amount: cents(amount), remainder: cents(total - amount) }
}

/**
 * Splits `total` across `weights` so the parts sum exactly to `total`. Leftover
 * cents go to the largest fractional remainders, ties to the earliest index.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0 || weights.some((w) => !(w >= 0)) || weights.every((w) => w === 0)) {
    throw new RangeError('Weights must be non-empty, non-negative, and not all zero')
  }
  const sign = total < 0 ? -1 : 1
  const abs = Math.abs(total)
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const exact = weights.map((w) => (abs * w) / weightSum)
  const floors = exact.map(Math.floor)
  let leftover = abs - floors.reduce((a, b) => a + b, 0)
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const { i } of order) {
    if (leftover <= 0) break
    floors[i]! += 1
    leftover -= 1
  }
  return floors.map((n) => cents(sign * n))
}
