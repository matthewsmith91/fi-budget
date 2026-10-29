import { parseCents } from '@budget-fi/core'
import { money } from './format.ts'

/** A dollar box that commits the difference on blur or Enter, and reverts on Escape. */
export function AssignedInput(props: {
  label: string
  value: number
  disabled?: boolean
  onCommit: (delta: number) => void
  onInvalid: () => void
}) {
  const shown = money(props.value)
  return (
    <input
      // a new key resets the field to the stored value after every save
      key={props.value}
      className="assigned-input"
      aria-label={props.label}
      inputMode="decimal"
      disabled={props.disabled}
      defaultValue={shown}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          e.currentTarget.value = shown
          e.currentTarget.blur()
        }
      }}
      onBlur={(e) => {
        const text = e.currentTarget.value
        if (text === shown) return
        const next = parseCents(text)
        if (next === null) {
          e.currentTarget.value = shown
          return props.onInvalid()
        }
        if (next !== props.value) props.onCommit(next - props.value)
        else e.currentTarget.value = shown
      }}
    />
  )
}
