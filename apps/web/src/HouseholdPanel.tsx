import type { Household } from '@budget-fi/core'
import { useState, type FormEvent } from 'react'
import { budget } from './client.ts'

export function HouseholdPanel(props: {
  household: Household | null | undefined
  loading: boolean
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [members, setMembers] = useState('Matt, Jessica')
  const [error, setError] = useState<string | null>(null)

  if (props.loading) return null

  if (props.household) {
    return (
      <section>
        <h2>{props.household.name}</h2>
        <ul>
          {props.household.members.map((m) => (
            <li key={m.id}>{m.displayName}</li>
          ))}
        </ul>
      </section>
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await budget.createHousehold({ name, members: members.split(',') })
      props.onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section>
      <h2>Set up your household</h2>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Household name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Members (comma separated)
          <input value={members} onChange={(e) => setMembers(e.target.value)} required />
        </label>
        <button type="submit">Create</button>
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  )
}
