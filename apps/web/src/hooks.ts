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
  const [canCheck, setCanCheck] = useState(false)
  const updateSW = useRef<((reload?: boolean) => Promise<void>) | null>(null)
  const registration = useRef<ServiceWorkerRegistration | undefined>(undefined)
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    updateSW.current = registerSW({
      onNeedRefresh: () => setNeedRefresh(true),
      onOfflineReady: () => setOfflineReady(true),
      onRegisteredSW: (_url, r) => {
        registration.current = r
        setCanCheck(r !== undefined)
        // The browser only looks for a new worker on a full load, and an installed app can stay
        // open for days, so ask the server every hour as well. A new bundle still waits for
        // "Update now".
        timer = setInterval(() => {
          if (navigator.onLine) void r?.update().catch(() => {})
        }, SW_CHECK_MS)
      },
    })
    return () => clearInterval(timer)
  }, [])
  const applyUpdate = useCallback(() => void updateSW.current?.(true), [])
  /**
   * Asks the server for a newer bundle now. Resolves 'ready' once one is installed and waiting
   * (`needRefresh` flips too) and 'current' when the server has nothing newer; rejects when the
   * server can't be reached. Without a service worker (dev, demo) there is nothing to ask.
   */
  const checkServer = useCallback(async (): Promise<'ready' | 'current'> => {
    const r = registration.current
    if (!r) return 'current'
    await r.update()
    const incoming = r.installing ?? r.waiting
    if (!incoming) return 'current'
    if (incoming.state === 'installing') {
      await new Promise<void>((resolve) => {
        const settled = () => {
          if (incoming.state === 'installing') return
          incoming.removeEventListener('statechange', settled)
          resolve()
        }
        incoming.addEventListener('statechange', settled)
      })
    }
    return incoming.state === 'redundant' ? 'current' : 'ready'
  }, [])
  return { needRefresh, offlineReady, applyUpdate, checkServer, canCheck }
}

const SW_CHECK_MS = 60 * 60 * 1000

export type ServiceWorkerState = ReturnType<typeof useServiceWorker>

/** Runs an async loader; re-runs when `reload()` is called or any of `deps` change. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[] = []) {
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
  }, [tick, ...deps])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}
