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
        <a
          href={hrefFor.settings}
          className={route.view === 'settings' ? 'foot-button active' : 'foot-button'}
          aria-label="Settings"
          title="Settings"
          aria-current={route.view === 'settings' ? 'page' : undefined}
          onClick={onNavigate}
        >
          <GearIcon />
        </a>
        <button
          type="button"
          className="foot-button"
          aria-label="Add Account"
          title="Add Account"
          onClick={onAddAccount}
        >
          <PlusIcon />
        </button>
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

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
