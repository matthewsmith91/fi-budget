import { useEffect, useRef } from 'react'
import { bankApi } from './bank.ts'
import { budget } from './client.ts'
import { useRefresh } from './data.ts'
import { drainImportQueue } from './queue-import.ts'

/** How often an open app checks whether the server's daily pull has found anything new. */
const CHECK_MS = 5 * 60_000

/**
 * Brings the server's daily bank pull into this device's budget, on opening and every few
 * minutes after. Quiet by design: with no server, no sign-in or no bank linked there is
 * nothing to do, and a failure just means trying again later.
 */
export function QueueImporter() {
  const refresh = useRefresh()
  const running = useRef(false)

  useEffect(() => {
    async function check() {
      if (running.current || !navigator.onLine) return
      running.current = true
      try {
        const summary = await drainImportQueue({
          fetchQueue: bankApi.queue,
          importTransactions: (accounts) => budget.importTransactions(accounts),
          markApplied: bankApi.markApplied,
        })
        if (summary && summary.added + summary.matched > 0) refresh()
      } catch {
        // signed out, offline or no server: the queue keeps until the next check
      } finally {
        running.current = false
      }
    }
    void check()
    const timer = setInterval(() => void check(), CHECK_MS)
    addEventListener('online', check)
    return () => {
      clearInterval(timer)
      removeEventListener('online', check)
    }
  }, [refresh])

  return null
}
