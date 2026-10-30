import { createContext, useContext } from 'react'
import type { SyncView } from './sync-state.ts'

export interface SyncShared {
  /** `null` for a device that does not sync (or before its status has loaded). */
  view: SyncView | null
  /** The sync status has been read, so a `null` view means "does not sync". */
  loaded: boolean
  /** Reading the sync status failed. */
  failed: boolean
  syncNow: () => Promise<void>
}

export const SyncContext = createContext<SyncShared>({
  view: null,
  loaded: false,
  failed: false,
  syncNow: async () => {},
})

export const useSync = () => useContext(SyncContext)
