import { useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { messageOf } from './errors.ts'

export function SetupView({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const [members, setMembers] = useState('Matt, Jessica')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await budget.createHousehold({ name, members: members.split(',') })
      onCreated()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <div className="page narrow">
      <section className="card">
        <h1>Set up your household</h1>
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
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      </section>
    </div>
  )
}
