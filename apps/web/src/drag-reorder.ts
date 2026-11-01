import { useEffect, useRef, useState, type PointerEvent } from 'react'

/**
 * `ids` with `id` taken out and put just before (or after) `target`; null when that leaves the
 * order as it was. `ids` is the whole list, hidden items included, because the API wants every id.
 */
export function moveNextTo(
  ids: readonly string[],
  id: string,
  target: string,
  after: boolean,
): string[] | null {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return null
  const rest = ids.filter((x) => x !== id)
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, id)
  return rest.every((x, i) => x === ids[i]) ? null : rest
}

export type DragKind = 'category' | 'group'

/** What is being dragged. A category can only land among the rows of its own `scope` (its group). */
export interface Dragged {
  kind: DragKind
  id: string
  scope: string
}

export interface DropPoint {
  kind: DragKind
  id: string
  after: boolean
}

/** Marks an element a drag can land on: spread on a table row (category) or body (group). */
export function dropTarget(kind: DragKind, id: string, scope = '') {
  return { 'data-drop-kind': kind, 'data-drop-id': id, 'data-drop-scope': scope }
}

/** Pixels from the top or bottom edge of the window where dragging scrolls the page. */
const EDGE = 90
/** How far the pointer must move before a press on the handle becomes a drag. */
const THRESHOLD = 4

/**
 * Pointer-based drag and drop (mouse, pen and touch alike; the HTML5 API has no touch). The handle
 * gets `handleProps`; rows say where a drag may land with `dropTarget`. `onMove` gets the item and
 * the row it was dropped beside. Escape or a cancelled pointer abandons the drag.
 */
export function useDragReorder(onMove: (drag: Dragged, target: string, after: boolean) => void) {
  const [dragging, setDragging] = useState<Dragged | null>(null)
  const [over, setOver] = useState<DropPoint | null>(null)
  const press = useRef<{ drag: Dragged; x: number; y: number; started: boolean } | null>(null)
  const overRef = useRef<DropPoint | null>(null)
  const pointerY = useRef(0)
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove

  function setTarget(next: DropPoint | null) {
    const same = next?.kind === overRef.current?.kind && next?.id === overRef.current?.id
    if (same && next?.after === overRef.current?.after) return
    overRef.current = next
    setOver(next)
  }

  function finish() {
    press.current = null
    setTarget(null)
    setDragging(null)
  }

  // Keep the page moving while the pointer rests near an edge.
  useEffect(() => {
    if (!dragging) return
    let frame = 0
    const tick = () => {
      const y = pointerY.current
      if (y < EDGE * 1.5) window.scrollBy(0, -Math.ceil((EDGE * 1.5 - y) / 6))
      else if (y > window.innerHeight - EDGE)
        window.scrollBy(0, Math.ceil((y - (window.innerHeight - EDGE)) / 6))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
    }
  }, [dragging])

  function locate(drag: Dragged, x: number, y: number) {
    pointerY.current = y
    const row = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>(`[data-drop-kind="${drag.kind}"]`)
    const id = row?.dataset.dropId
    if (!row || !id || id === drag.id || row.dataset.dropScope !== drag.scope) {
      setTarget(null)
      return
    }
    const box = row.getBoundingClientRect()
    setTarget({ kind: drag.kind, id, after: y > box.top + box.height / 2 })
  }

  function handleProps(drag: Dragged) {
    return {
      onPointerDown(e: PointerEvent<HTMLElement>) {
        if (e.button !== 0 || !e.isPrimary) return
        e.currentTarget.setPointerCapture(e.pointerId)
        press.current = { drag, x: e.clientX, y: e.clientY, started: false }
      },
      onPointerMove(e: PointerEvent<HTMLElement>) {
        const p = press.current
        if (!p) return
        if (!p.started) {
          if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < THRESHOLD) return
          p.started = true
          pointerY.current = e.clientY
          setDragging(p.drag)
        }
        locate(p.drag, e.clientX, e.clientY)
      },
      onPointerUp() {
        const p = press.current
        const at = overRef.current
        if (p?.started && at) onMoveRef.current(p.drag, at.id, at.after)
        finish()
      },
      onPointerCancel: finish,
      // a press-and-hold on a phone would otherwise open the text-selection or context menu
      onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
    }
  }

  return { dragging, over, handleProps }
}
