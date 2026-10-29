import { cents, formatCents } from '@budget-fi/core'

/** `$1,234.56`; negatives as `-$12.00`. */
export const money = (amount: number) => formatCents(cents(amount))

/** `$1.2M`, `$250K`, `$900`; for chart axes and other tight spots. Takes cents. */
export function moneyShort(amount: number): string {
  const dollars = Math.abs(amount) / 100
  const compact = (n: number, unit: string) => `${Number(n.toFixed(1))}${unit}`
  const text =
    dollars >= 1_000_000
      ? compact(dollars / 1_000_000, 'M')
      : dollars >= 1_000
        ? compact(dollars / 1_000, 'K')
        : String(Math.round(dollars))
  return `${amount < 0 ? '-' : ''}$${text}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Today in the device's time zone as `YYYY-MM-DD`. */
export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export const monthOf = (isoDate: string) => isoDate.slice(0, 7)

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const index = y * 12 + (m - 1) + by
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`
}

const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })

export function monthLabel(month: string): { name: string; year: string } {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return { name: monthName.format(new Date(Date.UTC(y, m - 1, 1))), year: String(y) }
}

/** `2026-10-28` as `10/28/2026`, without any time-zone shifting. */
export function shortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-')
  return `${m}/${d}/${y}`
}

/** Accepts `10/28/2026`, `10/28/26`, `10/28` (this year) or `2026-10-28`; null if not a real date. */
export function parseDate(text: string, now = new Date()): string | null {
  const t = text.trim()
  let y: number, m: number, d: number
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  else if ((match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t))) {
    m = Number(match[1])
    d = Number(match[2])
    y = match[3]
      ? match[3].length === 2
        ? 2000 + Number(match[3])
        : Number(match[3])
      : now.getFullYear()
  } else return null
  const iso = `${y}-${pad(m)}-${pad(d)}`
  const real = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(real.getTime()) || real.toISOString().slice(0, 10) !== iso ? null : iso
}
