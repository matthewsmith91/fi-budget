import type { Account, AccountBalance } from '@budget-fi/core'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { money } from './format.ts'
import { TabIcon } from './nav-icons.tsx'
import {
  isCurrent,
  isGroup,
  MORE_NAV,
  TAB_NAV,
  TOP_NAV,
  type NavGroup,
  type NavLink,
} from './nav-items.ts'
import { hrefFor, type Route } from './route.ts'
import { Sheet } from './Sheet.tsx'

interface Props {
  route: Route
  /** Imported transactions waiting for approval. */
  inboxCount: number
}

interface TabBarProps extends Props {
  accounts: Account[]
  balances: AccountBalance[]
  onAddAccount: () => void
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="nav-badge" aria-label={`${count} to review`}>
      {count}
    </span>
  )
}

/** The bar across the top on a wide screen. Hidden on a phone, where `TabBar` takes over. */
export function TopNav({ route, inboxCount }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)
  const root = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!openId) return
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpenId(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // hand focus back to the button that opened the list
      root.current?.querySelector<HTMLElement>(`[data-group="${openId}"]`)?.focus()
      setOpenId(null)
    }
    addEventListener('pointerdown', onPointer)
    addEventListener('keydown', onKey)
    return () => {
      removeEventListener('pointerdown', onPointer)
      removeEventListener('keydown', onKey)
    }
  }, [openId])

  const link = (item: NavLink) => (
    <a
      key={item.id}
      href={item.href}
      className={isCurrent(item, route) ? 'topnav-link active' : 'topnav-link'}
      aria-current={isCurrent(item, route) ? 'page' : undefined}
      onClick={() => setOpenId(null)}
    >
      {item.label}
      {item.id === 'inbox' && <Badge count={inboxCount} />}
    </a>
  )

  const group = (g: NavGroup) => {
    const open = openId === g.id
    const current = g.items.some((i) => isCurrent(i, route))
    return (
      <div key={g.id} className="topnav-group">
        <button
          type="button"
          data-group={g.id}
          className={current ? 'topnav-link active' : 'topnav-link'}
          aria-expanded={open}
          onClick={() => setOpenId(open ? null : g.id)}
        >
          {g.label}
          <span className="topnav-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {open && (
          <ul className="topnav-list plain">
            {g.items.map((item) => (
              <li key={item.id}>
                <a
                  href={item.href}
                  className={isCurrent(item, route) ? 'active' : undefined}
                  aria-current={isCurrent(item, route) ? 'page' : undefined}
                  onClick={() => setOpenId(null)}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <nav className="topnav" aria-label="Main navigation" ref={root}>
      {TOP_NAV.map((entry) => (isGroup(entry) ? group(entry) : link(entry)))}
    </nav>
  )
}

/**
 * The bar along the bottom on a phone: the main pages, and "More" for everything else, including
 * the accounts, Settings and Add Account (a phone has no sidebar).
 */
export function TabBar({ route, inboxCount, accounts, balances, onAddAccount }: TabBarProps) {
  const [more, setMore] = useState(false)
  const moreCurrent =
    MORE_NAV.some((i) => isCurrent(i, route)) ||
    route.view === 'account' ||
    route.view === 'settings'

  const balanceOf = (id: string) => balances.find((b) => b.accountId === id)?.balance ?? 0
  const live = accounts.filter((a) => !a.closed)
  const onBudget = live.filter((a) => a.onBudget)
  const tracking = live.filter((a) => !a.onBudget)
  const closed = accounts.filter((a) => a.closed)
  const close = () => setMore(false)

  const item = (key: string, href: string, label: string, active: boolean, extra?: ReactNode) => (
    <li key={key}>
      <a
        href={href}
        className={active ? 'active' : undefined}
        aria-current={active ? 'page' : undefined}
        onClick={close}
      >
        <span>{label}</span>
        {extra}
      </a>
    </li>
  )

  const accountItems = (list: Account[]) =>
    list.map((a) => {
      const balance = balanceOf(a.id)
      return item(
        a.id,
        hrefFor.account(a.id),
        a.name,
        route.view === 'account' && route.id === a.id,
        <span className={balance < 0 ? 'more-amount negative' : 'more-amount'}>
          {money(balance)}
        </span>,
      )
    })

  const accountGroup = (title: string, list: Account[]) =>
    list.length > 0 && (
      <section className="more-section" aria-label={`${title} accounts`}>
        <h3>
          <span>{title}</span>
          <span className="more-amount">
            {money(list.reduce((sum, a) => sum + balanceOf(a.id), 0))}
          </span>
        </h3>
        <ul className="plain more-list">{accountItems(list)}</ul>
      </section>
    )

  return (
    <>
      <nav className="tabbar" aria-label="Main navigation">
        {TAB_NAV.map((link) => (
          <a
            key={link.id}
            href={link.href}
            className={isCurrent(link, route) ? 'tab active' : 'tab'}
            aria-current={isCurrent(link, route) ? 'page' : undefined}
          >
            <span className="tab-icon-wrap">
              <TabIcon id={link.id} />
              {link.id === 'inbox' && <Bubble count={inboxCount} />}
            </span>
            <span className="tab-label">{link.tabLabel ?? link.label}</span>
          </a>
        ))}
        <button
          type="button"
          className={moreCurrent ? 'tab active' : 'tab'}
          aria-haspopup="dialog"
          onClick={() => setMore(true)}
        >
          <span className="tab-icon-wrap">
            <TabIcon id="more" />
          </span>
          <span className="tab-label">More</span>
        </button>
      </nav>

      {more && (
        <Sheet title="More" onClose={close}>
          <ul className="plain more-list">
            {MORE_NAV.map((link) => item(link.id, link.href, link.label, isCurrent(link, route)))}
          </ul>
          {accountGroup('Budget', onBudget)}
          {accountGroup('Tracking', tracking)}
          {closed.length > 0 && (
            <details className="more-section">
              <summary>Closed</summary>
              <ul className="plain more-list">{accountItems(closed)}</ul>
            </details>
          )}
          <div className="more-actions">
            <a
              href={hrefFor.settings}
              className="more-button"
              aria-current={route.view === 'settings' ? 'page' : undefined}
              onClick={close}
            >
              Settings
            </a>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                close()
                onAddAccount()
              }}
            >
              Add Account
            </button>
          </div>
        </Sheet>
      )}
    </>
  )
}

/** The inbox count on the phone's tab: a bubble on the icon's corner. */
function Bubble({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="tab-bubble" aria-label={`${count} to review`}>
      {count > 99 ? '99+' : count}
    </span>
  )
}
