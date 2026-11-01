import { useEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Shown on hover; say why an item is disabled. */
  title?: string
}

/** A "⋯" button with a dropdown of actions; closes on selection, Escape or an outside click. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    addEventListener('pointerdown', onPointer)
    addEventListener('keydown', onKey)
    return () => {
      removeEventListener('pointerdown', onPointer)
      removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span className="menu" ref={root}>
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        ⋯
      </button>
      {open && (
        <ul className="menu-list" role="menu">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setOpen(false)
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  )
}
