import { type CategoryBalance, type GoalBalance } from '@budget-fi/core'
import { useSyncExternalStore } from 'react'
import { budget } from './client.ts'
import { money } from './format.ts'
import { Skeleton } from './Skeleton.tsx'

/** True while the window matches `query`; follows it as the window changes size. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', notify)
      return () => list.removeEventListener('change', notify)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/**
 * Room for the neighbouring months: the sidebar plus the category column and seven figure
 * columns. Anything narrower (a phone, a shrunk window) shows the one open month.
 */
export const WIDE = '(min-width: 1180px)'

/** One neighbouring month's figures, tagged with the month so a late answer can't pass for another. */
export interface Peek {
  month: string
  categories: ReadonlyMap<string, CategoryBalance>
  goals: ReadonlyMap<string, GoalBalance>
}

export async function loadPeek(month: string): Promise<Peek> {
  const [rows, goals] = await Promise.all([
    budget.getMonthBalances(month),
    budget.getGoalBalances(month),
  ])
  return {
    month,
    categories: new Map(rows.map((r) => [r.categoryId, r])),
    goals: new Map(goals.map((g) => [g.goalId, g])),
  }
}

/** The peek for `month`, or undefined while it is still some other month's. */
export const peekFor = (q: { data?: Peek | undefined }, month: string) =>
  q.data?.month === month ? q.data : undefined

export interface PeekFigures {
  assigned: number
  available: number
}

const tone = (available: number) => (available < 0 ? 'bad' : available === 0 ? 'zero' : 'good')

/**
 * Assigned and Available for a neighbouring month: plain text, never an input. `figures` is
 * undefined while they load.
 */
export function PeekCells(props: { side: 'prev' | 'next'; figures: PeekFigures | undefined }) {
  const { figures } = props
  return (
    <>
      <td className={props.side === 'next' ? 'num peek peek-start' : 'num peek'}>
        {figures ? money(figures.assigned) : <Skeleton />}
      </td>
      <td className={props.side === 'prev' ? 'num peek peek-end' : 'num peek'}>
        {figures ? (
          <span className={`pill ${tone(figures.available)}`}>{money(figures.available)}</span>
        ) : (
          <Skeleton />
        )}
      </td>
    </>
  )
}

/** A category's figures in a peek, zero when the month has none for it. */
export const categoryFigures = (peek: Peek | undefined, id: string): PeekFigures | undefined =>
  peek && (peek.categories.get(id) ?? { assigned: 0, available: 0 })

/** A goal's figures in a peek, zero when the month has none for it. */
export const goalFigures = (peek: Peek | undefined, id: string): PeekFigures | undefined =>
  peek && (peek.goals.get(id) ?? { assigned: 0, available: 0 })
