import {
  cents,
  formatCents,
  parseCents,
  type NeedOrWant,
  type TransactionSplit,
} from '@budget-fi/core'

/** Cents as typed into an amount box: `1,234.50`, no symbol. */
export const plain = (amount: number) => formatCents(cents(amount), { symbol: false })

/** A split line as typed: a category and an amount in either the outflow or inflow box. */
export interface Line {
  categoryId: string
  /** A goal of `categoryId` the line is spent from, or ''. */
  goalId: string
  /** Tags the line as a need or a want whatever its category says, or '' to follow the category. */
  needOrWant: NeedOrWant | ''
  outflow: string
  inflow: string
}

export const emptyLine = (): Line => ({
  categoryId: '',
  goalId: '',
  needOrWant: '',
  outflow: '',
  inflow: '',
})

export const lineOf = (s: TransactionSplit): Line => ({
  categoryId: s.categoryId ?? '',
  goalId: s.goalId ?? '',
  needOrWant: s.needOrWant ?? '',
  outflow: s.amount < 0 ? plain(-s.amount) : '',
  inflow: s.amount > 0 ? plain(s.amount) : '',
})

/** The signed cents a line holds: 0 when empty, a message when it can't be read. */
export function amountOf(line: Line): number | string {
  const out = line.outflow.trim() === '' ? 0 : parseCents(line.outflow)
  const into = line.inflow.trim() === '' ? 0 : parseCents(line.inflow)
  if (out === null || into === null) return 'Enter amounts as dollars, like 42.50'
  if (out < 0 || into < 0) return 'Amounts must be positive; use Inflow for money in'
  return into - out
}

/**
 * Typing in one amount box empties the other: a line is money out or money in, and two filled
 * boxes would quietly net against each other.
 */
export function typeAmount(line: Line, side: 'outflow' | 'inflow', value: string): Line {
  const other = side === 'outflow' ? 'inflow' : 'outflow'
  return { ...line, [side]: value, ...(value.trim() === '' ? {} : { [other]: '' }) }
}

/**
 * The lines that going back to one line would lose: every line after the first whose category or
 * goal differs from the first's. Their amounts still count; only their categories are dropped.
 */
export function unsplitLoss(lines: Line[]): Line[] {
  const [first, ...rest] = lines
  if (!first) return []
  return rest.filter(
    (l) => l.categoryId !== '' && (l.categoryId !== first.categoryId || l.goalId !== first.goalId),
  )
}
