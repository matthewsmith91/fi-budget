import { cents, formatCents } from '@budget-fi/core'
import { AccountPanel } from './AccountPanel.tsx'
import { BackupPanel } from './BackupPanel.tsx'
import { DevicePanel } from './DevicePanel.tsx'
import { PayeeRulesPanel } from './PayeeRulesPanel.tsx'
import { SuggestPanel } from './SuggestPanel.tsx'
import { YnabImportPanel } from './YnabImportPanel.tsx'
import { budget } from './client.ts'
import { useBudgetQuery } from './data.ts'
import type { PersistState } from './hooks.ts'

export function SettingsView(props: {
  persist: PersistState
  offlineReady: boolean
  onBackupChanged: () => void
}) {
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
      <DevicePanel />
      <AccountPanel />
      <PayeeRulesPanel />
      <SuggestPanel />
      <YnabImportPanel />
      <BackupPanel onChanged={props.onBackupChanged} />
    </div>
  )
}
