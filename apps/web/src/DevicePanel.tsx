import type { Device, Household } from '@budget-fi/core'
import { useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'

/** Tells the budget who uses this device, so the activity feed can say who made a change. */
export function DevicePanel() {
  const device = useBudgetQuery(() => budget.getDevice())
  const household = useBudgetQuery(() => budget.getHousehold())
  if (device.loading || household.loading) return null
  return <DeviceForm device={device.data ?? null} members={household.data?.members ?? []} />
}

function DeviceForm(props: { device: Device | null; members: Household['members'] }) {
  const refresh = useRefresh()
  const [name, setName] = useState(props.device?.name ?? '')
  const [memberId, setMemberId] = useState(props.device?.memberId ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    try {
      await budget.setDevice({ name, memberId: memberId || null })
      setSaved(true)
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <section className="card">
      <h2>This device</h2>
      <p className="muted">
        Name this device and say who uses it, so the Activity page can show who made each change.
      </p>
      <form className="inline" onSubmit={(e) => void save(e)}>
        <label>
          Device name
          <input
            value={name}
            placeholder="Matt’s phone"
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label>
          Used by
          <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">Nobody in particular</option>
            {props.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Save</button>
      </form>
      {saved && <p role="status">Saved.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
