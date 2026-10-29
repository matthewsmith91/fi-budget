import { useState } from 'react'
import { messageOf } from './errors.ts'
import { useAsync } from './hooks.ts'
import { suggestApi } from './suggest.ts'

/**
 * Optional category suggestions for the inbox. The household’s Anthropic API key is saved on
 * the server (sealed), never on a device, and is never shown again once saved.
 */
export function SuggestPanel() {
  const status = useAsync(() => suggestApi.status())
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const current = status.data
  const shownModel = model ?? current?.model ?? ''

  async function run(fn: () => Promise<unknown>, done: string) {
    setError(null)
    setNote(null)
    setBusy(true)
    try {
      await fn()
      setNote(done)
      status.reload()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>Category suggestions</h2>
      <p className="muted">
        Optional. In the inbox, “Suggest categories” sends the payee names of what is waiting
        (nothing else: no amounts, dates or accounts), plus your category names, to Anthropic’s
        Claude and offers its guesses. You still pick and approve every one. It uses your own
        Anthropic API key, which is kept on the server and never shown again.
      </p>
      {status.loading && <p className="muted">Checking the server…</p>}
      {status.error && (
        <p className="muted">
          Sign in on the Household page, on a device that can reach the server, to set this up.
        </p>
      )}
      {current && (
        <>
          <p role="status">
            {current.enabled
              ? `On, using the key ending ${current.keyHint}${current.source === 'environment' ? ' set in the server’s environment' : ''} with ${current.model}.`
              : 'Off. Add an API key to turn it on.'}
          </p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault()
              const changes = {
                ...(apiKey.trim() && { apiKey: apiKey.trim() }),
                ...(model !== null && model !== current.model && { model }),
              }
              void run(
                async () => {
                  await suggestApi.save(changes)
                  setApiKey('')
                  setModel(null)
                },
                apiKey.trim() ? 'Key checked and saved.' : 'Model saved.',
              )
            }}
          >
            <label>
              Anthropic API key
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={current.enabled ? 'Paste a new key to replace it' : 'sk-ant-…'}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              Model
              <input
                value={shownModel}
                onChange={(e) => setModel(e.target.value)}
                spellCheck={false}
              />
            </label>
            <div className="row">
              <button
                type="submit"
                disabled={busy || (!apiKey.trim() && (model === null || model === current.model))}
              >
                {busy ? 'Checking…' : 'Save'}
              </button>
              {current.source === 'settings' && (
                <button
                  type="button"
                  className="secondary danger"
                  disabled={busy}
                  onClick={() => void run(() => suggestApi.remove(), 'Key removed.')}
                >
                  Remove key
                </button>
              )}
            </div>
          </form>
        </>
      )}
      {note && <p role="status">{note}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
