import type { CategoryRemoval } from '@budget-fi/core'
import { money } from './format.ts'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What removing a category will do, one sentence per consequence, for the confirmation. */
export function removalLines(
  plan: CategoryRemoval,
  name: string,
  /** The month the money goes back in, like "October 2026". */
  monthName: string,
): string[] {
  const lines =
    plan.outcome === 'deleted'
      ? [`${name} has never been used, so it will be deleted.`]
      : [`${name} has history, so it will be hidden, not deleted. Past transactions keep it.`]
  if (plan.returned > 0) {
    lines.push(`${money(plan.returned)} goes back to Ready to Assign for ${monthName}.`)
  }
  if (plan.goals > 0) {
    const goals = plural(plan.goals, 'goal', 'goals')
    lines.push(
      plan.outcome === 'deleted' ? `${goals} will be deleted.` : `${goals} will be archived.`,
    )
  }
  if (plan.rules > 0) {
    lines.push(
      `${plural(plan.rules, 'payee or income rule', 'payee and income rules')} will be deleted.`,
    )
  }
  if (plan.emergencyFund) lines.push('It will stop being your emergency fund.')
  if (plan.outcome === 'hidden') lines.push('Show hidden categories to bring it back.')
  return lines
}
