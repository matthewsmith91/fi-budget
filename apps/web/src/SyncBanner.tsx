import { useSync } from './sync-context.ts'
import { describeSync } from './sync-state.ts'

/** Whether the budget on this device matches the server's: synced, offline, or changes waiting. */
export function SyncBanner() {
  const { view, syncNow } = useSync()
  if (!view) return null
  const problem = view.kind !== 'synced' && view.kind !== 'syncing'
  return (
    <div
      className={problem ? `banner sync ${view.kind} warn` : `banner sync ${view.kind}`}
      role="status"
      data-sync={view.kind}
    >
      <span>{describeSync(view)}</span>
      {view.kind === 'signin' && <a href="#/settings/household">Sign in</a>}
      {(view.kind === 'unsynced' || view.kind === 'error') && (
        <button onClick={() => void syncNow()}>Sync now</button>
      )}
    </div>
  )
}
