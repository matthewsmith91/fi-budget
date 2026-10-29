import type { AccountHolding, Goal, GoalBalance } from '@budget-fi/core'
import { money } from './format.ts'

const short = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })

/** `2027-03-15` as `Mar 2027`. */
export function targetLabel(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number]
  return short.format(new Date(Date.UTC(y, m - 1, 1)))
}

/** The lines under a goal's name: how full it is, what it needs each month, what is still due. */
export function goalStatus(
  goal: Goal,
  balance: GoalBalance | undefined,
  /** The name of the account the goal is held in, if it has one. */
  heldIn?: string,
): string[] {
  const percent = balance?.percentFunded ?? 0
  const lines = [`${percent}% of ${money(goal.targetAmount)}`]
  if (heldIn) lines.push(`Held in ${heldIn}`)
  if (percent >= 100) return [...lines, 'Fully funded']
  if (goal.targetDate && balance?.monthlyNeeded != null) {
    lines.push(`${money(balance.monthlyNeeded)}/mo for ${targetLabel(goal.targetDate)}`)
    if (balance.underfunded > 0) lines.push(`${money(balance.underfunded)} more to assign`)
  }
  return lines
}

/** The over-allocation warning for an account, or null when it covers the goals held in it. */
export function holdingWarning(holding: AccountHolding, accountName: string): string | null {
  if (holding.over <= 0) return null
  return `${accountName} has ${money(holding.balance)}, but the goals held in it add up to ${money(holding.held)}. ${money(holding.over)} of that money isn’t there.`
}
