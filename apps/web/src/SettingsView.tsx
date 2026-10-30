import { useState } from 'react'
import { AccountPanel } from './AccountPanel.tsx'
import { authApi } from './auth.ts'
import { BackupPanel } from './BackupPanel.tsx'
import { BankPanel } from './BankPanel.tsx'
import { DevicePanel } from './DevicePanel.tsx'
import { IncomeRulesPanel } from './IncomeRulesPanel.tsx'
import { PayeeRulesPanel } from './PayeeRulesPanel.tsx'
import { SuggestPanel } from './SuggestPanel.tsx'
import { YnabImportPanel } from './YnabImportPanel.tsx'
import { budget } from './client.ts'
import { useBudgetQuery } from './data.ts'
import { getBackupState } from './device-settings.ts'
import { useAsync, type PersistState } from './hooks.ts'
import { useSync } from './sync-context.ts'
import { hrefFor, SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSection } from './route.ts'
import { backupRow, offlineRow, protectionRow, storageRow, syncRow } from './settings-status.ts'

export function SettingsView(props: {
  section: SettingsSection
  persist: PersistState
  offlineReady: boolean
  onBackupChanged: () => void
}) {
  const { section } = props
  if (section === null) {
    return <SettingsRoot persist={props.persist} offlineReady={props.offlineReady} />
  }
  return (
    <SettingsPage section={section}>
      {section === 'household' ? (
        <>
          <DevicePanel />
          <AccountPanel />
        </>
      ) : section === 'connections' ? (
        <Connections />
      ) : section === 'payee-rules' ? (
        <PayeeRulesPanel />
      ) : section === 'income-rules' ? (
        <IncomeRulesPanel />
      ) : section === 'imports' ? (
        <YnabImportPanel />
      ) : (
        <BackupPanel onChanged={props.onBackupChanged} />
      )}
    </SettingsPage>
  )
}

function SettingsPage(props: {
  section: Exclude<SettingsSection, null>
  children: React.ReactNode
}) {
  const label = SETTINGS_SECTIONS.find((s) => s.id === props.section)!.label
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{label}</h1>
          <p className="muted page-blurb">{SECTION_BLURBS[props.section]}</p>
        </div>
      </header>
      {props.children}
    </div>
  )
}

/** Banks and the Anthropic key both live on the server, so both need a household sign-in. */
function Connections() {
  const auth = useAsync(() => authApi.status())
  if (auth.loading)
    return (
      <p className="muted" role="status">
        Checking the server…
      </p>
    )
  if (auth.error) {
    return (
      <section className="card">
        <h2>Can’t reach the server</h2>
        <p className="muted">
          Bank links and the Anthropic key are kept on the server, so they need a connection to it.
          Everything else in the app still works without one.
        </p>
        <div className="row">
          <button type="button" onClick={auth.reload}>
            Try Again
          </button>
        </div>
      </section>
    )
  }
  if (!auth.data?.user) {
    return (
      <section className="card">
        <h2>Sign in first</h2>
        <p className="muted">
          Bank links and the Anthropic key are kept on the server, so they need a household sign-in.{' '}
          <a href={hrefFor.settingsSection('household')}>Go to Household</a>.
        </p>
      </section>
    )
  }
  return (
    <>
      <BankPanel />
      <SuggestPanel />
    </>
  )
}

const SECTION_BLURBS: Record<Exclude<SettingsSection, null>, string> = {
  household: 'Name this device, sign in with a passkey, pair devices and turn on sync.',
  connections: 'Link your bank through SimpleFIN and set up category suggestions.',
  'payee-rules': 'Categorize imported transactions by who was paid.',
  'income-rules': 'Assign a share of each paycheck, like the tithe, before anything else.',
  imports: 'Bring in your history from YNAB.',
  backups: 'Export the budget, or restore it from a file.',
}

function SettingsRoot(props: { persist: PersistState; offlineReady: boolean }) {
  const status = useBudgetQuery(() => budget.getStatus())
  const sync = useSync()
  const [now] = useState(() => new Date())
  const [backup] = useState(() => getBackupState(now))
  const rows = [
    storageRow(status.data?.storage),
    protectionRow(props.persist),
    backupRow(backup, now),
    syncRow(sync, now),
    offlineRow(props.offlineReady),
  ].filter((row) => row !== null)
  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <section className="card" aria-labelledby="your-data">
        <h2 id="your-data">Your data</h2>
        <ul className="plain status-list">
          {rows.map((row) => (
            <li key={row.label} className={`status-row status-${row.tone}`}>
              <span className="status-label">{row.label}</span>
              <span className="status-text">
                <span className="status-mark" aria-hidden="true">
                  {row.tone === 'ok' ? '✓' : row.tone === 'warn' ? '⚠' : ''}
                </span>
                {row.text}
              </span>
              {row.action && <a href={row.action.href}>{row.action.label}</a>}
            </li>
          ))}
        </ul>
      </section>
      {SETTINGS_GROUPS.map((g) => (
        <section key={g.id} aria-labelledby={`settings-group-${g.id}`}>
          <h2 id={`settings-group-${g.id}`} className="group-heading">
            {g.label}
          </h2>
          <ul className="plain settings-links">
            {SETTINGS_SECTIONS.filter((s) => s.group === g.id).map((s) => (
              <li key={s.id}>
                <a className="settings-link" href={hrefFor.settingsSection(s.id)}>
                  <span className="settings-link-label">{s.label}</span>
                  <span className="settings-link-blurb">{SECTION_BLURBS[s.id]}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="muted about">
        Schema version {status.data?.schemaVersion ?? '…'} · SQLite{' '}
        {status.data?.sqliteVersion ?? '…'}
      </p>
    </div>
  )
}
