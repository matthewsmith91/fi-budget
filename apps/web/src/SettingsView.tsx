import { cents, formatCents } from '@budget-fi/core'
import { AccountPanel } from './AccountPanel.tsx'
import { authApi } from './auth.ts'
import { BackupPanel } from './BackupPanel.tsx'
import { BankPanel } from './BankPanel.tsx'
import { DevicePanel } from './DevicePanel.tsx'
import { PayeeRulesPanel } from './PayeeRulesPanel.tsx'
import { SuggestPanel } from './SuggestPanel.tsx'
import { YnabImportPanel } from './YnabImportPanel.tsx'
import { budget } from './client.ts'
import { useBudgetQuery } from './data.ts'
import { useAsync, type PersistState } from './hooks.ts'
import { hrefFor, SETTINGS_SECTIONS, type SettingsSection } from './route.ts'

export function SettingsView(props: {
  section: SettingsSection
  persist: PersistState
  offlineReady: boolean
  onBackupChanged: () => void
}) {
  if (props.section === 'household') {
    return (
      <SettingsPage title="Household">
        <DevicePanel />
        <AccountPanel />
      </SettingsPage>
    )
  }
  if (props.section === 'connections') {
    return (
      <SettingsPage title="Connections">
        <Connections />
      </SettingsPage>
    )
  }
  if (props.section === 'payee-rules') {
    return (
      <SettingsPage title="Payee rules">
        <PayeeRulesPanel />
      </SettingsPage>
    )
  }
  if (props.section === 'imports') {
    return (
      <SettingsPage title="Imports">
        <YnabImportPanel />
      </SettingsPage>
    )
  }
  if (props.section === 'backups') {
    return (
      <SettingsPage title="Backups">
        <BackupPanel onChanged={props.onBackupChanged} />
      </SettingsPage>
    )
  }
  return <SettingsRoot persist={props.persist} offlineReady={props.offlineReady} />
}

function SettingsPage(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="page">
      <header className="page-header">
        <h1>{props.title}</h1>
      </header>
      {props.children}
    </div>
  )
}

/** Banks and the Anthropic key both live on the server, so both need a household sign-in. */
function Connections() {
  const auth = useAsync(() => authApi.status())
  if (auth.loading) return <p className="muted">Checking the server…</p>
  if (!auth.data?.user) {
    return (
      <section className="card">
        <h2>Sign in first</h2>
        <p className="muted">
          Bank links and the Anthropic key are kept on the server, so they need a household sign-in.{' '}
          {auth.error ? 'No sync server is reachable from here. ' : ''}
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
  imports: 'Bring in your history from YNAB.',
  backups: 'Export the budget, or restore it from a file.',
}

function SettingsRoot(props: { persist: PersistState; offlineReady: boolean }) {
  const status = useBudgetQuery(() => budget.getStatus())
  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <section className="card">
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
          <dd>{props.persist}</dd>
          <dt>Schema version</dt>
          <dd>{status.data?.schemaVersion ?? '…'}</dd>
          <dt>SQLite</dt>
          <dd>{status.data?.sqliteVersion ?? '…'}</dd>
          <dt>Offline ready</dt>
          <dd>{props.offlineReady ? 'yes' : 'not yet'}</dd>
          <dt>Money check</dt>
          <dd>{formatCents(cents(123456))}</dd>
        </dl>
      </section>
      <section className="card">
        <h2>Sections</h2>
        <dl>
          {SETTINGS_SECTIONS.map((s) => (
            <div key={s.id} className="settings-link">
              <dt>
                <a href={hrefFor.settingsSection(s.id)}>{s.label}</a>
              </dt>
              <dd>{SECTION_BLURBS[s.id]}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}
