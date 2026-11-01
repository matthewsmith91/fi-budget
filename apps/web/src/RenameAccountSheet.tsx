import type { Account } from '@budget-fi/core'
import { useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { Sheet } from './Sheet.tsx'

/** Mounted only while shown. A failed rename shows its reason here, beside the name. */
export function RenameAccountSheet(props: { account: Account; onClose: () => void }) {
  const refresh = useRefresh()
  const [name, setName] = useState(props.account.name)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const unchanged = name.trim() === props.account.name

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    setError(null)
    setSaving(true)
    try {
      await budget.updateAccount(props.account.id, { name })
      refresh()
      props.onClose()
    } catch (err) {
      setError(messageOf(err))
      setSaving(false)
    }
  }

  return (
    <Sheet title="Rename account" onClose={props.onClose}>
      <form className="sheet-rename" onSubmit={(e) => void submit(e)}>
        <label>
          Account name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <button type="submit" disabled={unchanged || name.trim() === '' || saving}>
          Save name
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  )
}
