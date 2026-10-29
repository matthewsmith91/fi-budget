import type { InvestmentKind, InvestmentMode, TaxType } from '@budget-fi/core'

export const TAX_TYPE_LABELS: Record<TaxType, string> = {
  roth: 'Roth',
  traditional: 'Traditional',
  taxable: 'Taxable',
  '529': '529',
}

export const INVESTMENT_MODE_LABELS: Record<InvestmentMode, string> = {
  units: 'Units: goals share the whole account',
  holdings: 'Holdings: goals hold different investments',
}

export const INVESTMENT_KIND_LABELS: Record<InvestmentKind, string> = {
  brokerage: 'Brokerage',
  ira: 'IRA',
  '401k': '401(k)',
  '403b': '403(b)',
  '457': '457',
  '401a': '401(a)',
  'sep-ira': 'SEP IRA',
  'simple-ira': 'SIMPLE IRA',
  '529': '529 plan',
  other: 'Other',
}
