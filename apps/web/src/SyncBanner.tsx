import { useCallback, useEffect, useRef, useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { changeCount, shouldAutoSync, syncView, type SyncView } from './sync-state.ts'

/** How long to wait after a change before sending it, so a burst of edits goes out together. */
const SEND_DELAY_MS = 1500
/** How often a synced, online device asks the server for the other person's changes. */
const POLL_MS = 30_000

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    addEventListener('online', up)
    addEventListener('offline', down)
    return () => {
      removeEventListener('online', up)
      removeEventListener('offline', down)
    }
  }, [])
  return online
}

/** Sync status for a device that syncs, with automatic syncing; `null` otherwise. */
function useSyncView() {
  const refresh = useRefresh()
  const status = useBudgetQuery(() => budget.getSyncStatus())
  const online = useOnline()
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = syncView({ status: status.data, online, syncing, error })
  const linked = status.data?.linked === true
  const running = useRef(false)

  const syncNow = useCallback(async () => {
    if (running.current) return
    running.current = true
    setSyncing(true)
    try {
      const result = await budget.syncNow()
      setError(null)
      // Only re-read the budget when the sync changed it; polling must not redraw every view.
      if (result.pulled > 0 || result.repaired) refresh()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      running.current = false
      setSyncing(false)
      status.reload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, status.reload])

  // Send waiting changes shortly after they are made. A failure stops this until something
  // changes (back online, the poll below, "Sync now"), so a broken server is not hammered.
  const auto = shouldAutoSync(view)
  useEffect(() => {
    if (!auto) return
    const timer = setTimeout(() => void syncNow(), SEND_DELAY_MS)
    return () => clearTimeout(timer)
  }, [auto, syncNow, status.data?.pending])

  // Back online: retry now, and keep asking the server for the other person's changes.
  useEffect(() => {
    if (!linked || !online) return
    void syncNow()
    const timer = setInterval(() => void syncNow(), POLL_MS)
    return () => clearInterval(timer)
  }, [linked, online, syncNow])

  return { view, syncNow }
}

function describe(view: SyncView): string {
  switch (view.kind) {
    case 'syncing':
      return 'Syncing…'
    case 'offline':
      return view.pending > 0
        ? `Offline. ${changeCount(view.pending)} will sync when you’re back online.`
        : 'Offline. Changes you make will sync when you’re back online.'
    case 'signin':
      return `Signed out of the server, so changes aren’t syncing${view.pending > 0 ? ` (${changeCount(view.pending)} waiting)` : ''}.`
    case 'error':
      return `Couldn’t sync: ${view.message}`
    case 'unsynced':
      return `${changeCount(view.pending)} not yet synced.`
    case 'synced':
      return view.lastSyncAt
        ? `Synced at ${new Date(view.lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
        : 'Synced.'
  }
}

/** Whether the budget on this device matches the server's: synced, offline, or changes waiting. */
export function SyncBanner() {
  const { view, syncNow } = useSyncView()
  if (!view) return null
  const problem = view.kind !== 'synced' && view.kind !== 'syncing'
  return (
    <div
      className={problem ? `banner sync ${view.kind} warn` : `banner sync ${view.kind}`}
      role="status"
      data-sync={view.kind}
    >
      <span>{describe(view)}</span>
      {view.kind === 'signin' && <a href="#/settings">Sign in</a>}
      {(view.kind === 'unsynced' || view.kind === 'error') && (
        <button onClick={() => void syncNow()}>Sync now</button>
      )}
    </div>
  )
}
