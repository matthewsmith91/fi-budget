import { useEffect, useId, useRef, type ReactNode } from 'react'

/**
 * A modal panel: a sheet rising from the bottom on a phone, a centred panel on a larger screen.
 * Mounted only while shown; a tap on the backdrop, Escape or Close calls `onClose`.
 */
export function Sheet(props: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="dialog sheet"
      aria-labelledby={titleId}
      onClose={props.onClose}
      // the dialog box itself is the target only when the backdrop is clicked
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div className="sheet-body">
        <header className="sheet-header">
          <h2 id={titleId}>{props.title}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  )
}
