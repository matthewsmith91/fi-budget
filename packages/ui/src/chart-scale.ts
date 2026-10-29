/** A step of 1, 2, 2.5 or 5 times a power of ten that is at least `raw`. */
function niceStep(raw: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(raw)))
  const fraction = raw / power
  return (
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power
  )
}

export interface Axis {
  min: number
  max: number
  /** Evenly spaced, from `min` to `max`. */
  ticks: number[]
}

/**
 * A y axis that covers `[low, high]` with round tick values, about `count` of them. A range
 * with no spread gets a unit of room either side so the line doesn't sit on the frame.
 */
export function niceAxis(low: number, high: number, count = 5): Axis {
  if (!(high > low)) {
    const pad = Math.max(Math.abs(low) * 0.1, 1)
    low -= pad
    high += pad
  }
  const step = niceStep((high - low) / Math.max(count - 1, 1))
  const min = Math.floor(low / step) * step
  const max = Math.ceil(high / step) * step
  const ticks: number[] = []
  // multiply instead of accumulating so 0.1 + 0.2 style drift never shows in a tick
  for (let i = 0; min + i * step <= max + step / 1e6; i++) ticks.push(min + i * step)
  return { min, max, ticks }
}

/**
 * Indexes of at most `count` of `n` points at an even step, counted back from the last so
 * the newest is always labelled. The first point is included only when the step lands on it.
 */
export function spreadIndexes(n: number, count: number): number[] {
  if (n <= 0) return []
  if (n <= count || count < 2) return n <= count ? Array.from({ length: n }, (_, i) => i) : [n - 1]
  const step = Math.ceil((n - 1) / (count - 1))
  const indexes: number[] = []
  for (let i = n - 1; i >= 0; i -= step) indexes.unshift(i)
  return indexes
}
