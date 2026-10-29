import type { IncomeRule } from '@budget-fi/core'

/** "Acme Payroll in Checking → 10% of gross pay → Tithe", for the rules list. */
export function describeIncomeRule(
  rule: Pick<IncomeRule, 'match' | 'percent' | 'fixedAmount' | 'basis'>,
  names: { account: string | null; target: string; money: (cents: number) => string },
): string {
  const where = [
    rule.match ? `“${rule.match}”` : null,
    names.account ? `in ${names.account}` : null,
  ]
    .filter(Boolean)
    .join(' ')
  const what =
    rule.percent !== null
      ? `${rule.percent}% of ${rule.basis === 'gross' ? 'gross pay' : 'the deposit'}`
      : names.money(rule.fixedAmount ?? 0)
  return `${where} → ${what} → ${names.target}`
}
