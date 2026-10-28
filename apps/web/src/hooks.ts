import { useCallback, useEffect, useRef, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

export type PersistState = 'unknown' | 'granted' | 'denied' | 'unsupported'

/** Asks the browser not to evict the budget under storage pressure. */
export function usePersistentStorage(): PersistState {
  // navigator.storage is missing in insecure contexts, though the DOM types say otherwise
  const supported = (navigator.storage as StorageManager | undefined)?.persist !== undefined
  const [state, setState] = useState<PersistState>(supported ? 'unknown' : 'unsupported')
  useEffect(() => {
    if (!supported) return
    const storage = navigator.storage
    void (async () => {
      const already = await storage.persisted()
      setState(already || (await storage.persist()) ? 'granted' : 'denied')
    })()
  }, [supported])
  return state
}

/** Registers the service worker; `needRefresh` flips when a new version is waiting. */
export function useServiceWorker() {
  const [needRefresh, setNeedRefresh] = useState(false)
  const [offlineReady, setOfflineReady] = useState(false)
  const updateSW = useRef<((reload?: boolean) => Promise<void>) | null>(null)
  useEffect(() => {
    updateSW.current = registerSW({
      onNeedRefresh: () => setNeedRefresh(true),
      onOfflineReady: () => setOfflineReady(true),
    })
  }, [])
  const applyUpdate = useCallback(() => void updateSW.current?.(true), [])
  return { needRefresh, offlineReady, applyUpdate }
}

/** Runs an async loader and re-runs it when `reload()` is called. */
export function useAsync<T>(load: () => Promise<T>) {
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({
    loading: true,
  })
  useEffect(() => {
    let live = true
    load().then(
      (data) => live && setState({ data, loading: false }),
      (error: unknown) =>
        live &&
        setState({
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
        }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}
