import type { EmergencyDraw, EmergencyFund } from '@budget-fi/core'
import { money } from './format.ts'

/** How far the balance is to the target, as a whole percent from 0 to 100, rounded down. */
export function fundPercent(fund: Pick<EmergencyFund, 'balance' | 'target'>): number {
  if (fund.target <= 0) return 0
  return Math.min(100, Math.max(0, Math.floor((fund.balance * 100) / fund.target)))
}

/** The line under the fund's name in the budget. */
export function fundStatus(fund: EmergencyFund): string[] {
  if (fund.target <= 0) return ['No Need spending to size a target yet']
  const covered = fund.monthsCovered === null ? '0.0' : fund.monthsCovered.toFixed(1)
  return [
    `Covers ${covered} of ${fund.settings.months} months`,
    fund.shortfall > 0 ? `${money(fund.shortfall)} to go` : 'Target met',
  ]
}

/** How long the fund took to get back to where it would have been, for the emergencies table. */
export function refillText(draw: Pick<EmergencyDraw, 'balanceAfter' | 'refilledIn'>): string {
  if (draw.balanceAfter === null) return '—'
  if (draw.refilledIn === null) return 'Not yet'
  if (draw.refilledIn === 0) return 'Right away'
  return `${draw.refilledIn} ${draw.refilledIn === 1 ? 'month' : 'months'}`
}
