import { createContext, useContext } from 'react'
import { useAsync } from './hooks.ts'

export interface Refresh {
  version: number
  /** Call after any write so every view re-reads the budget. */
  refresh: () => void
}

export const DataContext = createContext<Refresh>({ version: 0, refresh: () => {} })

export const useRefresh = () => useContext(DataContext).refresh

/** Like `useAsync`, but also re-runs whenever anything in the budget changes. */
export function useBudgetQuery<T>(load: () => Promise<T>, deps: readonly unknown[] = []) {
  const { version } = useContext(DataContext)
  return useAsync(load, [version, ...deps])
}
