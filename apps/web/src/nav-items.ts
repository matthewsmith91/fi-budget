import { hrefFor, type Route } from './route.ts'

export interface NavLink {
  id: string
  label: string
  /** The bottom tab bar on a phone has room for five words. */
  tabLabel?: string
  href: string
  /** Route views that make this link the current page. */
  views: readonly Route['view'][]
}

export interface NavGroup {
  id: string
  label: string
  items: readonly NavLink[]
}

const budget: NavLink = { id: 'budget', label: 'Budget', href: hrefFor.budget, views: ['budget'] }
const inbox: NavLink = { id: 'inbox', label: 'Inbox', href: hrefFor.inbox, views: ['inbox'] }
const accounts: NavLink = {
  id: 'accounts',
  label: 'All Accounts',
  tabLabel: 'Register',
  href: hrefFor.accounts,
  views: ['accounts'],
}
const bills: NavLink = { id: 'bills', label: 'Bills', href: hrefFor.bills, views: ['bills'] }
const review: NavLink = {
  id: 'review',
  label: 'Monthly review',
  href: hrefFor.review,
  views: ['review'],
}
const reports: NavLink = {
  id: 'reports',
  label: 'Reports',
  href: hrefFor.reports,
  views: ['reports'],
}
const activity: NavLink = {
  id: 'activity',
  label: 'Activity',
  href: hrefFor.activity,
  views: ['activity'],
}

/** The bar across the top on a wide screen: single links and dropdowns, in order. */
export const TOP_NAV: readonly (NavLink | NavGroup)[] = [
  budget,
  inbox,
  accounts,
  { id: 'plan', label: 'Plan', items: [bills, review] },
  { id: 'insights', label: 'Insights', items: [reports, activity] },
]

/** The bar along the bottom on a phone: what is used most, reachable by thumb. */
export const TAB_NAV: readonly NavLink[] = [budget, inbox, accounts, reports]

/** Everything else on a phone, behind the last tab. */
export const MORE_NAV: readonly NavLink[] = [bills, review, activity]

/** Every page, for the drawer behind the ☰ on a phone, so nothing depends on the tab bar. */
export const DRAWER_NAV: readonly NavLink[] = [
  budget,
  inbox,
  accounts,
  bills,
  review,
  reports,
  activity,
]

export function isGroup(entry: NavLink | NavGroup): entry is NavGroup {
  return 'items' in entry
}

export function isCurrent(link: NavLink, route: Route): boolean {
  return link.views.includes(route.view)
}
