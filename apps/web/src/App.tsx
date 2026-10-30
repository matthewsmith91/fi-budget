import { backupReminderDue } from '@budget-fi/core'
import { useState } from 'react'
import { ActivityView } from './ActivityView.tsx'
import { AddAccountDialog } from './AddAccountDialog.tsx'
import { BillsView } from './BillsView.tsx'
import { BudgetView } from './BudgetView.tsx'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { DataProvider } from './DataProvider.tsx'
import { getBackupState } from './device-settings.ts'
import { InboxView } from './InboxView.tsx'
import { QueueImporter } from './QueueImporter.tsx'
import { ReportsView } from './ReportsView.tsx'
import { ReviewView } from './ReviewView.tsx'
import { usePersistentStorage, useServiceWorker } from './hooks.ts'
import { RegisterView } from './RegisterView.tsx'
import { useRoute } from './route.ts'
import { SettingsView } from './SettingsView.tsx'
import { SetupView } from './SetupView.tsx'
import { Sidebar } from './Sidebar.tsx'
import { SyncBanner } from './SyncBanner.tsx'
import { SyncProvider } from './SyncProvider.tsx'

export default function App() {
  return (
    <DataProvider>
      <Shell />
    </DataProvider>
  )
}

function Shell() {
  const refresh = useRefresh()
  const status = useBudgetQuery(() => budget.getStatus())
  const household = useBudgetQuery(() => budget.getHousehold())
  const accounts = useBudgetQuery(() => budget.listAccounts())
  const balances = useBudgetQuery(() => budget.getAccountBalances())
  const inbox = useBudgetQuery(() => budget.listTransactions({ unapproved: true }))
  const persist = usePersistentStorage()
  const sw = useServiceWorker()
  const route = useRoute()
  const [now] = useState(() => new Date())
  const [backup, setBackup] = useState(getBackupState)
  const [navOpen, setNavOpen] = useState(false)
  const [adding, setAdding] = useState(false)

  if (status.error) return <StartupError error={status.error} />

  // The Settings page lists these itself, in its "Your data" card
  const onSettingsRoot = route.view === 'settings' && route.section === null
  const reminderDue = backupReminderDue({ ...backup, now }) && !onSettingsRoot
  const noHousehold = !household.loading && !household.data

  let content: React.ReactNode
  if (noHousehold) {
    content = <SetupView onCreated={refresh} />
  } else if (route.view === 'budget') {
    content = <BudgetView today={now} />
  } else if (route.view === 'inbox') {
    content = <InboxView accounts={accounts.data ?? []} />
  } else if (route.view === 'activity') {
    content = <ActivityView />
  } else if (route.view === 'reports') {
    content = <ReportsView today={now} />
  } else if (route.view === 'bills') {
    content = <BillsView today={now} />
  } else if (route.view === 'review') {
    content = <ReviewView today={now} month={route.month} />
  } else if (route.view === 'settings') {
    content = (
      <SettingsView
        section={route.section}
        persist={persist}
        offlineReady={sw.offlineReady}
        onBackupChanged={() => {
          setBackup(getBackupState())
          refresh()
        }}
      />
    )
  } else {
    content = (
      <RegisterView
        accountId={route.view === 'account' ? route.id : null}
        accounts={accounts.data ?? []}
        accountsLoaded={!accounts.loading}
        onAddAccount={() => setAdding(true)}
      />
    )
  }

  return (
    <SyncProvider>
      <div className="shell">
        <header className="topbar">
          <button
            type="button"
            className="icon-button"
            aria-label="Menu"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(!navOpen)}
          >
            ☰
          </button>
          <span>{household.data?.name ?? 'Household Budget'}</span>
        </header>

        <Sidebar
          household={household.data ?? null}
          accounts={accounts.data ?? []}
          balances={balances.data ?? []}
          inboxCount={inbox.data?.length ?? 0}
          route={route}
          open={navOpen}
          onNavigate={() => setNavOpen(false)}
          onAddAccount={() => {
            setNavOpen(false)
            setAdding(true)
          }}
        />
        {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

        <main>
          {household.data && <QueueImporter />}
          <SyncBanner />
          {sw.needRefresh && (
            <div className="banner" role="status">
              A new version is ready. <button onClick={sw.applyUpdate}>Update now</button>
            </div>
          )}
          {status.data?.storage === 'memory' && (
            <div className="banner warn" role="alert">
              This browser can’t keep data between visits. Everything here is lost when you close
              the tab. Export a backup before leaving, or open the app in a different browser.
            </div>
          )}
          {persist === 'denied' && !onSettingsRoot && (
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
              This budget only exists on this device, so{' '}
              <a href="#/settings/backups">export a backup</a>.
            </div>
          )}
          {content}
        </main>

        <AddAccountDialog open={adding} onClose={() => setAdding(false)} />
      </div>
    </SyncProvider>
  )
}

function StartupError({ error }: { error: Error }) {
  return (
    <main className="startup-error">
      <h1>Household Budget</h1>
      <div className="banner warn" role="alert">
        <strong>The budget couldn’t be opened.</strong>
        <p>{error.message}</p>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    </main>
  )
}
