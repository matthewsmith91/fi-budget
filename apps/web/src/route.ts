import { useEffect, useState } from 'react'
import { filterHref, monthFilter, parseFilter, type RegisterFilter } from './register-filter.ts'

export type Route =
  /** `month` is null for the current month, which keeps following today. */
  | { view: 'budget'; month: string | null }
  | { view: 'accounts'; filter: RegisterFilter }
  | { view: 'account'; id: string }
  | { view: 'inbox' }
  | { view: 'activity' }
  | { view: 'reports' }
  | { view: 'bills' }
  | { view: 'review'; month: string | null }
  | { view: 'settings'; section: SettingsSection }

export const SETTINGS_SECTIONS = [
  { id: 'household', label: 'Household', group: 'setup' },
  { id: 'connections', label: 'Connections', group: 'setup' },
  { id: 'payee-rules', label: 'Payee rules', group: 'automation' },
  { id: 'income-rules', label: 'Income rules', group: 'automation' },
  { id: 'imports', label: 'Imports', group: 'data' },
  { id: 'backups', label: 'Backups', group: 'data' },
] as const

/** How the settings pages are grouped, in order, on the Settings page and in its sidebar. */
export const SETTINGS_GROUPS = [
  { id: 'setup', label: 'Setup' },
  { id: 'automation', label: 'Automation' },
  { id: 'data', label: 'Data' },
] as const

/** `null` is the Settings root page. */
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'] | null

export function parseRoute(hash: string): Route {
  // `#/settings/household?code=…` is a pairing link; the query is not part of the route
  const [path = '', query] = hash.split('?')
  const [, first, id] = path.split('/')
  const monthOf = (value: string | undefined) => (/^\d{4}-\d{2}$/.test(value ?? '') ? value! : null)
  if (first === 'accounts') {
    if (id) return { view: 'account', id: decodeURIComponent(id) }
    return { view: 'accounts', filter: parseFilter(query ?? '') }
  }
  if (first === 'inbox') return { view: 'inbox' }
  if (first === 'activity') return { view: 'activity' }
  if (first === 'reports') return { view: 'reports' }
  if (first === 'bills') return { view: 'bills' }
  if (first === 'review') return { view: 'review', month: monthOf(id) }
  if (first === 'settings') {
    const section = SETTINGS_SECTIONS.find((s) => s.id === id)
    return { view: 'settings', section: section?.id ?? null }
  }
  return { view: 'budget', month: first === 'budget' ? monthOf(id) : null }
}

export const hrefFor = {
  budget: '#/budget',
  /** The budget open on one month; the current month is plain `budget`. */
  budgetFor: (month: string) => `#/budget/${month}`,
  accounts: '#/accounts',
  /** All Accounts narrowed to one category's transactions in a month. */
  categoryActivity: (categoryId: string, month: string) =>
    filterHref(monthFilter(categoryId, month)),
  /** All Accounts with a filter applied. */
  accountsFiltered: filterHref,
  account: (id: string) => `#/accounts/${encodeURIComponent(id)}`,
  inbox: '#/inbox',
  activity: '#/activity',
  reports: '#/reports',
  bills: '#/bills',
  review: '#/review',
  /** The review for one month, like when following an overspent category. */
  reviewFor: (month: string) => `#/review/${month}`,
  settings: '#/settings',
  settingsSection: (section: Exclude<SettingsSection, null>) => `#/settings/${section}`,
}

/** The view comes from the URL hash so reloads and the back button behave. */
export function useRoute(): Route {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const onChange = () => setHash(location.hash)
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  return parseRoute(hash)
}
