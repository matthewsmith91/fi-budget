import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ConfirmDialog, type ConfirmOptions, type Pending } from './ConfirmDialog.tsx'

export type { ConfirmOptions }

/**
 * An in-app replacement for `window.confirm`: `await ask({...})` resolves true on the confirm
 * button and false on anything else. Render `dialog` once, anywhere outside a table.
 */
export function useConfirm(): {
  ask: (options: ConfirmOptions) => Promise<boolean>
  dialog: ReactNode
} {
  const [pending, setPending] = useState<Pending | null>(null)
  const current = useRef<Pending | null>(null)
  const ask = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        // a second question while one is open answers the first with "no"
        current.current?.resolve(false)
        const item: Pending = {
          ...options,
          resolve: (ok) => {
            if (current.current === item) {
              current.current = null
              setPending(null)
            }
            resolve(ok)
          },
        }
        current.current = item
        setPending(item)
      }),
    [],
  )
  return { ask, dialog: pending && <ConfirmDialog pending={pending} /> }
}
