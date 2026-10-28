import { backupReminderDue, cents, formatCents } from '@budget-fi/core'
import { useState } from 'react'
import { BackupPanel } from './BackupPanel.tsx'
import { budget } from './client.ts'
import { getBackupState } from './device-settings.ts'
import { useAsync, usePersistentStorage, useServiceWorker } from './hooks.ts'
import { HouseholdPanel } from './HouseholdPanel.tsx'

export default function App() {
  const status = useAsync(() => budget.getStatus())
  const household = useAsync(() => budget.getHousehold())
  const persist = usePersistentStorage()
  const sw = useServiceWorker()
  const [now] = useState(() => new Date())
  const [backup, setBackup] = useState(getBackupState)

  const refresh = () => {
    status.reload()
    household.reload()
    setBackup(getBackupState())
  }

  if (status.error) return <StartupError error={status.error} />

  const reminderDue = backupReminderDue({ ...backup, now })

  return (
    <main>
      <h1>Household Budget</h1>

      {sw.needRefresh && (
        <div className="banner" role="status">
          A new version is ready. <button onClick={sw.applyUpdate}>Update now</button>
        </div>
      )}
      {status.data?.storage === 'memory' && (
        <div className="banner warn" role="alert">
          This browser can’t keep data between visits. Everything here is lost when you close the
          tab. Export a backup before leaving, or open the app in a different browser.
        </div>
      )}
      {persist === 'denied' && (
        <div className="banner warn" role="status">
          The browser hasn’t promised to keep this data. Installing the app to your home screen
          usually fixes that. Until then, back up regularly.
        </div>
      )}
      {reminderDue && household.data && (
        <div className="banner warn" role="status">
          {backup.lastBackupAt
            ? `Your last backup was on ${new Date(backup.lastBackupAt).toLocaleDateString()}.`
            : 'This device has never been backed up.'}{' '}
          This budget only exists on this device, so export a backup below.
        </div>
      )}

      <section>
        <h2>Status</h2>
        <dl>
          <dt>Storage</dt>
          <dd>
            {status.data
              ? status.data.storage === 'opfs'
                ? 'On this device'
                : 'Memory only'
              : '…'}
          </dd>
          <dt>Persistent storage</dt>
          <dd>{persist}</dd>
          <dt>Schema version</dt>
          <dd>{status.data?.schemaVersion ?? '…'}</dd>
          <dt>SQLite</dt>
          <dd>{status.data?.sqliteVersion ?? '…'}</dd>
          <dt>Offline ready</dt>
          <dd>{sw.offlineReady ? 'yes' : 'not yet'}</dd>
          <dt>Money check</dt>
          <dd>{formatCents(cents(123456))}</dd>
        </dl>
      </section>

      <HouseholdPanel household={household.data} loading={household.loading} onCreated={refresh} />
      <BackupPanel onChanged={refresh} />
    </main>
  )
}

function StartupError({ error }: { error: Error }) {
  return (
    <main>
      <h1>Household Budget</h1>
      <div className="banner warn" role="alert">
        <strong>The budget couldn’t be opened.</strong>
        <p>{error.message}</p>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    </main>
  )
}
