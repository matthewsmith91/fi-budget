import {
  MAX_RETIREMENT_MULTIPLIER,
  RETIREMENT_STATUSES,
  type Category,
  type RetirementStatus,
} from '@budget-fi/core'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { messageOf } from './errors.ts'
import { RETIREMENT_STATUS_LABELS } from './retirement-text.ts'

const HELP: Record<RetirementStatus, string> = {
  continues: 'Spending stays the same once paychecks stop.',
  ends: 'It stops: 529 and retirement contributions, a mortgage that gets paid off.',
  changes: 'It becomes a different amount: travel ×1.5, commuting ×0.',
}

/** Mounted only while shown. Saves through `onSave`, which throws to show an error. */
export function RetirementStatusDialog(props: {
  category: Category
  onSave: (status: RetirementStatus, multiplier: number | null) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [status, setStatus] = useState(props.category.retirementStatus)
  const [multiplier, setMultiplier] = useState(String(props.category.retirementMultiplier ?? 1))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const value = Number(multiplier)
    if (status === 'changes' && (multiplier.trim() === '' || !Number.isFinite(value))) {
      return setError('Enter what spending is multiplied by, like 1.5')
    }
    try {
      await props.onSave(status, status === 'changes' ? value : null)
      props.onClose()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="retirement-status-title"
      onClose={props.onClose}
    >
      <form onSubmit={(e) => void submit(e)}>
        <h2 id="retirement-status-title">{props.category.name} in retirement</h2>
        <fieldset className="choices">
          <legend className="muted">What happens to this spending?</legend>
          {RETIREMENT_STATUSES.map((s) => (
            <label key={s} className="check">
              <input
                type="radio"
                name="retirement-status"
                checked={status === s}
                onChange={() => setStatus(s)}
              />
              <span>
                {RETIREMENT_STATUS_LABELS[s]}
                <small className="muted"> · {HELP[s]}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {status === 'changes' && (
          <label>
            Multiplier
            <input
              type="number"
              inputMode="decimal"
              min={0.01}
              max={MAX_RETIREMENT_MULTIPLIER}
              step="any"
              value={multiplier}
              onChange={(e) => setMultiplier(e.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit">Save</button>
        </div>
      </form>
    </dialog>
  )
}
