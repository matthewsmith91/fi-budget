import type { SyncStatus } from '@budget-fi/core'

/** What the sync banner says; `null` for a device that does not sync. */
export type SyncView =
  | { kind: 'syncing'; pending: number }
  | { kind: 'offline'; pending: number }
  | { kind: 'signin'; pending: number }
  | { kind: 'error'; pending: number; message: string }
  | { kind: 'unsynced'; pending: number }
  | { kind: 'synced'; lastSyncAt: string | null }

export interface SyncInputs {
  status: SyncStatus | undefined
  online: boolean
  syncing: boolean
  /** The message of the last failed sync, cleared by the next success. */
  error: string | null
}

// The error's status code does not survive the trip from the worker, only its message.
const UNREACHABLE = 'Could not reach the server'
const SIGN_IN = 'Sign in to sync'

export function syncView({ status, online, syncing, error }: SyncInputs): SyncView | null {
  if (!status?.linked) return null
  const { pending } = status
  if (syncing) return { kind: 'syncing', pending }
  if (!online || error === UNREACHABLE) return { kind: 'offline', pending }
  if (error === SIGN_IN) return { kind: 'signin', pending }
  if (error) return { kind: 'error', pending, message: error }
  if (pending > 0) return { kind: 'unsynced', pending }
  return { kind: 'synced', lastSyncAt: status.lastSyncAt }
}

/** Whether the app should try a sync by itself now. */
export function shouldAutoSync(view: SyncView | null): boolean {
  return view?.kind === 'unsynced'
}

export const changeCount = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`

/** What the banner and the Settings page say about a sync view, so the two never disagree. */
export function describeSync(view: SyncView): string {
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
