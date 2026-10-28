import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { DataContext } from './data.ts'

export function DataProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion((v) => v + 1), [])
  const value = useMemo(() => ({ version, refresh }), [version, refresh])
  return <DataContext value={value}>{children}</DataContext>
}
