import type { SyncSetup } from '@budget-fi/core'
import { useState } from 'react'
import { budget } from './client.ts'
import { useRefresh } from './data.ts'
import { downloadBlob, stamp } from './download.ts'
import { messageOf } from './errors.ts'
import { useAsync } from './hooks.ts'

/** Turning on sync for this device: upload its budget, or take the household's from the server. */
export function SyncPanel() {
  const refreshBudget = useRefresh()
  const setup = useAsync(() => budget.getSyncSetup())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  async function run(fn: () => Promise<string>) {
    setMessage(null)
    setBusy(true)
    try {
      setMessage({ text: await fn() })
    } catch (err) {
      setMessage({ text: messageOf(err), error: true })
    } finally {
      setBusy(false)
      setup.reload()
      refreshBudget()
    }
  }

  const syncNow = () =>
    run(async () => {
      const result = await budget.syncNow()
      return result.uploadedFile
        ? 'Synced, and sent the server a full copy for new devices.'
        : 'Synced.'
    })

  const download = (keepBackup: boolean) =>
    run(async () => {
      const result = await budget.downloadServerBudget()
      if (keepBackup) {
        downloadBlob(
          `budget-before-sync-${stamp()}.sqlite`,
          result.safetyBackup as Uint8Array<ArrayBuffer>,
          'application/vnd.sqlite3',
        )
      }
      return 'This device now has the household’s budget.'
    })

  return (
    <div className="stack">
      <h3>Sync</h3>
      {setup.loading && <p className="muted">Checking the server…</p>}
      {setup.error && (
        <p className="error" role="alert">
          {setup.error.message}
        </p>
      )}
      {setup.data && (
        <SetupActions
          setup={setup.data}
          busy={busy}
          onSync={() => void syncNow()}
          onDownload={(keepBackup) => void download(keepBackup)}
        />
      )}
      {message && (
        <p className={message.error ? 'error' : 'ok'} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </div>
  )
}

function SetupActions(props: {
  setup: SyncSetup
  busy: boolean
  onSync: () => void
  onDownload: (keepBackup: boolean) => void
}) {
  const { setup, busy } = props
  const serverHasBudget = setup.server.messages > 0

  if (setup.linked) {
    return (
      <div className="row">
        <button disabled={busy} onClick={props.onSync}>
          Sync now
        </button>
      </div>
    )
  }

  if (!setup.hasBudget) {
    if (!serverHasBudget) {
      return <p className="muted">Nothing to sync yet. Set up the household first.</p>
    }
    return (
      <>
        <p className="muted">The household already has a budget on the server.</p>
        <div className="row">
          <button
            disabled={busy}
            // Without a stored file the device simply receives the whole history as changes.
            onClick={setup.server.file ? () => props.onDownload(false) : props.onSync}
          >
            Set up this device from the server
          </button>
        </div>
      </>
    )
  }

  if (!serverHasBudget) {
    return (
      <>
        <p className="muted">
          This budget only exists on this device. Turning on sync uploads it so your other devices
          can download it.
        </p>
        <div className="row">
          <button disabled={busy} onClick={props.onSync}>
            Turn on sync
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <p className="error" role="alert">
        This device has a budget of its own, and the server already has one. They can’t be merged.
      </p>
      <div className="row">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            const ok = confirm(
              'This replaces everything in the budget on this device with the household’s budget from the server. A backup of this device’s budget will download first. Continue?',
            )
            if (ok) props.onDownload(true)
          }}
        >
          Replace this device’s budget with the server’s
        </button>
      </div>
    </>
  )
}
