import { useEffect, useRef, useState } from 'react'
import {
  isCurrent,
  isGroup,
  MORE_NAV,
  TAB_NAV,
  TOP_NAV,
  type NavGroup,
  type NavLink,
} from './nav-items.ts'
import type { Route } from './route.ts'
import { Sheet } from './Sheet.tsx'

interface Props {
  route: Route
  /** Imported transactions waiting for approval. */
  inboxCount: number
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

/** The bar along the bottom on a phone: the main pages, and "More" for the rest. */
export function TabBar({ route, inboxCount }: Props) {
  const [more, setMore] = useState(false)
  const moreCurrent = MORE_NAV.some((i) => isCurrent(i, route))

  return (
    <>
      <nav className="tabbar" aria-label="Main navigation">
        {TAB_NAV.map((item) => (
          <a
            key={item.id}
            href={item.href}
            className={isCurrent(item, route) ? 'tab active' : 'tab'}
            aria-current={isCurrent(item, route) ? 'page' : undefined}
          >
            <span className="tab-label">{item.tabLabel ?? item.label}</span>
            {item.id === 'inbox' && <Badge count={inboxCount} />}
          </a>
        ))}
        <button
          type="button"
          className={moreCurrent ? 'tab active' : 'tab'}
          aria-haspopup="dialog"
          onClick={() => setMore(true)}
        >
          <span className="tab-label">More</span>
        </button>
      </nav>

      {more && (
        <Sheet title="More" onClose={() => setMore(false)}>
          <ul className="plain more-list">
            {MORE_NAV.map((item) => (
              <li key={item.id}>
                <a
                  href={item.href}
                  className={isCurrent(item, route) ? 'active' : undefined}
                  aria-current={isCurrent(item, route) ? 'page' : undefined}
                  onClick={() => setMore(false)}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
    </>
  )
}
