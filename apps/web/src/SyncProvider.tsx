import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { SyncContext } from './sync-context.ts'
import { shouldAutoSync, syncView } from './sync-state.ts'

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

/** Sync status for a device that syncs, with automatic syncing; `view` is `null` otherwise. */
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

  const loaded = status.data !== undefined
  const failed = status.error !== undefined
  return { view, loaded, failed, syncNow }
}

/** Runs sync once for the whole app and shares what it finds with the banner and Settings. */
export function SyncProvider({ children }: { children: ReactNode }) {
  const { view, loaded, failed, syncNow } = useSyncView()
  const value = useMemo(() => ({ view, loaded, failed, syncNow }), [view, loaded, failed, syncNow])
  return <SyncContext value={value}>{children}</SyncContext>
}
