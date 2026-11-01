import { useEffect, useRef, type ReactNode } from 'react'

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** Colours the confirm button as destructive and puts focus on the safe choice. */
  danger?: boolean
}

export interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

export function ConfirmDialog({ pending }: { pending: Pending }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => dialog.current?.showModal(), [])
  const done = (ok: boolean) => pending.resolve(ok)
  return (
    <dialog
      ref={dialog}
      className="dialog confirm"
      role="alertdialog"
      aria-labelledby="confirm-title"
      aria-describedby={pending.message ? 'confirm-message' : undefined}
      // Escape closes a dialog natively; that counts as "no"
      onClose={() => pending.resolve(false)}
    >
      <h2 id="confirm-title">{pending.title}</h2>
      {pending.message && <div id="confirm-message">{pending.message}</div>}
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary"
          autoFocus={pending.danger}
          onClick={() => done(false)}
        >
          {pending.cancelLabel ?? 'Cancel'}
        </button>
        <button
          type="button"
          className={pending.danger ? 'danger' : undefined}
          autoFocus={!pending.danger}
          onClick={() => done(true)}
        >
          {pending.confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
