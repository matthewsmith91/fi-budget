import { parseCents } from '@budget-fi/core'
import { useEffect, useId, useRef, useState } from 'react'
import { messageOf } from './errors.ts'
import { money } from './format.ts'

const SAVED_FOR_MS = 1800

/**
 * A dollar box that commits the difference on blur or Enter, and reverts on Escape. It says
 * what happened beside the box: a tick once the write is saved, the reason when it isn't.
 */
export function AssignedInput(props: {
  label: string
  value: number
  disabled?: boolean
  /** Rejects when the write fails, so the box can show why. */
  onCommit: (delta: number) => void | Promise<void>
}) {
  const shown = money(props.value)
  const input = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const errorId = useId()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  // Follow the stored value after a save or a sync, unless the person is typing in the box.
  useEffect(() => {
    const el = input.current
    if (el && document.activeElement !== el) el.value = shown
  }, [shown])

  async function commit(el: HTMLInputElement) {
    const text = el.value
    if (text === shown) return
    const next = parseCents(text)
    if (next === null) {
      el.value = shown
      return setError('Enter the amount as dollars, like 250.00')
    }
    if (next === props.value) {
      el.value = shown
      return
    }
    try {
      await props.onCommit(next - props.value)
    } catch (err) {
      el.value = shown
      return setError(messageOf(err))
    }
    setSaved(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setSaved(false), SAVED_FOR_MS)
  }

  return (
    <span className="assigned-field">
      <input
        ref={input}
        className="assigned-input"
        aria-label={props.label}
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        inputMode="decimal"
        disabled={props.disabled}
        defaultValue={shown}
        onFocus={(e) => {
          setError(null)
          setSaved(false)
          e.currentTarget.select()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.currentTarget.value = shown
            e.currentTarget.blur()
          }
        }}
        onBlur={(e) => void commit(e.currentTarget)}
      />
      {/* always in the page, so a screen reader hears the text appear */}
      <span className="saved-mark" role="status">
        {saved && (
          <>
            <span aria-hidden="true">✓</span>
            <span className="sr-only">Saved</span>
          </>
        )}
      </span>
      {error && (
        <span id={errorId} className="error assigned-error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}
