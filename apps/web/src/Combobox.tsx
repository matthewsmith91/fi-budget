import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { rankOptions, type ComboOption } from './combo-options.ts'

interface Props {
  /** The accessible name; there is no visible label in a register row. */
  label: string
  options: ComboOption[]
  /**
   * `select`: the value is one of the options, and typing only narrows the list.
   * `text`: the value is whatever is typed, and the options are suggestions.
   */
  mode: 'select' | 'text'
  value: string
  onChange: (value: string) => void
  /** `select` only: the text of the choice that clears the value, also shown as the placeholder. */
  blankLabel?: string
  disabled?: boolean
  autoFocus?: boolean
  inputRef?: (el: HTMLInputElement | null) => void
  /** The longest list drawn. */
  limit?: number
}

const BLANK = ''

/**
 * A text box with a list of matches under it (the ARIA 1.2 combobox pattern). Arrow keys move,
 * Enter or Tab picks, Escape closes the list. Enter and Escape only act on the list while it is
 * open, so otherwise they reach the row (save, cancel).
 */
export function Combobox(props: Props) {
  const { options, mode, value, label, blankLabel, limit = 50 } = props
  const id = useId()
  const input = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // `select` mode: what is typed while narrowing; null shows the chosen option instead.
  const [query, setQuery] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  // -1 is nothing highlighted; `text` mode starts there so Enter saves the row.
  const [active, setActive] = useState(-1)
  const [place, setPlace] = useState<CSSProperties>({})

  const chosen = useMemo(() => options.find((o) => o.value === value), [options, value])
  const shownText =
    mode === 'text'
      ? value
      : (query ??
        (value === BLANK ? '' : chosen ? (chosen.display ?? chosen.label) : 'Unknown choice'))

  const typed = mode === 'text' ? value : (query ?? '')
  const matches = useMemo(() => {
    let found = rankOptions(options, typed, limit)
    // typing exactly a suggestion needs no list
    if (mode === 'text') {
      const same = typed.trim().toLowerCase()
      found = found.filter((o) => o.label.toLowerCase() !== same)
    }
    return found
  }, [options, typed, limit, mode])
  // In select mode the first entry clears the choice, offered while nothing is typed.
  const rows: ComboOption[] = useMemo(
    () =>
      mode === 'select' && blankLabel !== undefined && typed.trim() === ''
        ? [{ value: BLANK, label: blankLabel }, ...matches]
        : matches,
    [mode, blankLabel, typed, matches],
  )
  const showList = open && rows.length > 0

  const measure = () => {
    const el = input.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const below = innerHeight - rect.bottom - 8
    const above = rect.top - 8
    const up = below < 180 && above > below
    setPlace({
      left: rect.left,
      minWidth: Math.max(rect.width, 200),
      maxHeight: Math.max(120, Math.min(320, up ? above : below)),
      ...(up ? { bottom: innerHeight - rect.top + 2 } : { top: rect.bottom + 2 }),
    })
  }
  useLayoutEffect(() => {
    if (showList) measure()
  }, [showList, rows.length])
  useEffect(() => {
    if (!showList) return
    // the list is fixed to the screen, so follow the input when anything scrolls
    addEventListener('scroll', measure, true)
    addEventListener('resize', measure)
    return () => {
      removeEventListener('scroll', measure, true)
      removeEventListener('resize', measure)
    }
  }, [showList])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, showList])

  function close() {
    setOpen(false)
    setActive(-1)
  }

  function pick(option: ComboOption) {
    props.onChange(option.value)
    setQuery(null)
    close()
  }

  function move(by: number) {
    if (!showList) {
      setOpen(true)
      setActive(mode === 'select' ? 0 : by > 0 ? 0 : rows.length - 1)
      return
    }
    setActive((a) => (a + by + rows.length) % rows.length)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter' && showList && rows[active]) {
      // picking must not also save the row
      e.preventDefault()
      e.stopPropagation()
      pick(rows[active]!)
    } else if (e.key === 'Escape' && showList) {
      e.stopPropagation()
      setQuery(null)
      close()
    } else if (e.key === 'Tab' && showList && rows[active] && typed.trim() !== '') {
      pick(rows[active]!)
    }
  }

  return (
    <>
      <input
        ref={(el) => {
          input.current = el
          props.inputRef?.(el)
        }}
        className="combobox"
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${id}-${active}` : undefined}
        autoComplete="off"
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        placeholder={mode === 'select' ? blankLabel : undefined}
        value={shownText}
        onFocus={(e) => mode === 'select' && e.currentTarget.select()}
        onClick={() => mode === 'select' && !props.disabled && setOpen(true)}
        onChange={(e) => {
          if (mode === 'text') props.onChange(e.target.value)
          else setQuery(e.target.value)
          setOpen(true)
          setActive(mode === 'select' ? 0 : -1)
        }}
        onBlur={() => {
          setQuery(null)
          close()
        }}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul id={`${id}-list`} ref={listRef} className="combo-list" role="listbox" style={place}>
          {rows.map((o, i) => {
            const heading = typed.trim() === '' && o.group && o.group !== rows[i - 1]?.group
            return (
              <li key={o.value || BLANK} role="presentation">
                {heading && <span className="combo-group">{o.group}</span>}
                <span
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={
                    (o.indent && typed.trim() === '' ? 'combo-option indent' : 'combo-option') +
                    (o.value === value ? ' current' : '')
                  }
                  // the input must keep focus, so choose on press rather than on click
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pick(o)
                  }}
                  onMouseMove={() => setActive(i)}
                >
                  {o.indent && typed.trim() === '' ? `↳ ${o.label}` : (o.display ?? o.label)}
                  {typed.trim() !== '' && o.group && <span className="combo-hint">{o.group}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
