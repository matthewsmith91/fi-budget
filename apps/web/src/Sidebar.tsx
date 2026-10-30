import type { Account, AccountBalance, Household } from '@budget-fi/core'
import { hrefFor, SETTINGS_GROUPS, SETTINGS_SECTIONS, type Route } from './route.ts'
import { money } from './format.ts'

interface Props {
  household: Household | null
  accounts: Account[]
  balances: AccountBalance[]
  /** Imported transactions waiting for approval. */
  inboxCount: number
  route: Route
  open: boolean
  onNavigate: () => void
  onAddAccount: () => void
}

export function Sidebar(props: Props) {
  return props.route.view === 'settings' ? (
    <SettingsSidebar
      household={props.household}
      route={props.route}
      open={props.open}
      onNavigate={props.onNavigate}
    />
  ) : (
    <BudgetSidebar {...props} />
  )
}

/** Settings swaps the budget navigation for its own, with a way back. */
function SettingsSidebar(props: {
  household: Household | null
  route: Extract<Route, { view: 'settings' }>
  open: boolean
  onNavigate: () => void
}) {
  const link = (href: string, label: string, active: boolean) => (
    <a
      href={href}
      className={active ? 'nav-item active' : 'nav-item'}
      aria-current={active ? 'page' : undefined}
      onClick={props.onNavigate}
    >
      <span className="nav-label">{label}</span>
    </a>
  )

  return (
    <aside className={props.open ? 'sidebar open' : 'sidebar'} aria-label="Settings navigation">
      <div className="sidebar-head">
        <a href={hrefFor.budget} className="back-link" onClick={props.onNavigate}>
          ← Back to budget
        </a>
        <span className="household-name">{props.household?.name ?? 'Household Budget'}</span>
      </div>
      <nav>
        {link(hrefFor.settings, 'Settings', props.route.section === null)}
        {SETTINGS_GROUPS.map((g) => (
          <div key={g.id} className="account-section">
            <h2>{g.label}</h2>
            <ul className="plain">
              {SETTINGS_SECTIONS.filter((s) => s.group === g.id).map((s) => (
                <li key={s.id}>
                  {link(hrefFor.settingsSection(s.id), s.label, props.route.section === s.id)}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  )
}

function BudgetSidebar({
  household,
  accounts,
  balances,
  inboxCount,
  route,
  open,
  onNavigate,
  onAddAccount,
}: Props) {
  const balanceOf = (id: string) => balances.find((b) => b.accountId === id)?.balance ?? 0
  const live = accounts.filter((a) => !a.closed)
  const onBudget = live.filter((a) => a.onBudget)
  const tracking = live.filter((a) => !a.onBudget)
  const closed = accounts.filter((a) => a.closed)
  const total = (list: Account[]) => list.reduce((sum, a) => sum + balanceOf(a.id), 0)

  const link = (href: string, label: string, active: boolean, extra?: React.ReactNode) => (
    <a
      href={href}
      className={active ? 'nav-item active' : 'nav-item'}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
    >
      <span className="nav-label">{label}</span>
      {extra}
    </a>
  )

  const accountLinks = (list: Account[]) =>
    list.map((a) => {
      const balance = balanceOf(a.id)
      return link(
        hrefFor.account(a.id),
        a.name,
        route.view === 'account' && route.id === a.id,
        <span className={balance < 0 ? 'nav-amount negative' : 'nav-amount'}>
          {money(balance)}
        </span>,
      )
    })

  return (
    <aside className={open ? 'sidebar open' : 'sidebar'} aria-label="Budget navigation">
      <div className="sidebar-head">
        <span className="household-name">{household?.name ?? 'Household Budget'}</span>
        {household && (
          <span className="household-members">
            {household.members.map((m) => m.displayName).join(' & ')}
          </span>
        )}
      </div>

      <nav>
        {link(hrefFor.budget, 'Budget', route.view === 'budget')}
        {link(
          hrefFor.inbox,
          'Inbox',
          route.view === 'inbox',
          inboxCount > 0 && (
            <span className="nav-badge" aria-label={`${inboxCount} to review`}>
              {inboxCount}
            </span>
          ),
        )}
        {link(hrefFor.accounts, 'All Accounts', route.view === 'accounts')}
        {link(hrefFor.activity, 'Activity', route.view === 'activity')}
        {link(hrefFor.reports, 'Reports', route.view === 'reports')}
        {link(hrefFor.bills, 'Bills', route.view === 'bills')}
        {link(hrefFor.review, 'Review', route.view === 'review')}

        <AccountSection title="Budget" total={total(onBudget)} show={onBudget.length > 0}>
          {accountLinks(onBudget)}
        </AccountSection>
        <AccountSection title="Tracking" total={total(tracking)} show={tracking.length > 0}>
          {accountLinks(tracking)}
        </AccountSection>
        {closed.length > 0 && (
          <details className="account-section closed-section">
            <summary>Closed</summary>
            {accountLinks(closed)}
          </details>
        )}
      </nav>

      <div className="sidebar-foot">
        <button type="button" className="add-account" onClick={onAddAccount}>
          + Add Account
        </button>
        {link(hrefFor.settings, 'Settings', route.view === 'settings')}
      </div>
    </aside>
  )
}

function AccountSection(props: {
  title: string
  total: number
  show: boolean
  children: React.ReactNode
}) {
  if (!props.show) return null
  return (
    <section className="account-section" aria-label={`${props.title} accounts`}>
      <h2>
        <span>{props.title}</span>
        <span className="nav-amount">{money(props.total)}</span>
      </h2>
      {props.children}
    </section>
  )
}
