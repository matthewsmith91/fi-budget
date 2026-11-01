import { describe, expect, it } from 'vitest'
import { moveNextTo } from './drag-reorder.ts'

describe('moveNextTo', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves an item before a later one', () => {
    expect(moveNextTo(ids, 'a', 'c', false)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('moves an item after a later one', () => {
    expect(moveNextTo(ids, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves an item up', () => {
    expect(moveNextTo(ids, 'd', 'b', false)).toEqual(['a', 'd', 'b', 'c'])
    expect(moveNextTo(ids, 'd', 'a', true)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('returns null when nothing would change', () => {
    expect(moveNextTo(ids, 'b', 'a', true)).toBeNull()
    expect(moveNextTo(ids, 'a', 'b', false)).toBeNull()
    expect(moveNextTo(ids, 'c', 'c', true)).toBeNull()
  })

  it('returns null for an id that is not in the list', () => {
    expect(moveNextTo(ids, 'x', 'a', false)).toBeNull()
    expect(moveNextTo(ids, 'a', 'x', false)).toBeNull()
  })

  it('keeps items the view does not show', () => {
    // 'h' is hidden: dragging a before c still lists every id once
    expect(moveNextTo(['a', 'h', 'c'], 'a', 'c', false)).toEqual(['h', 'a', 'c'])
  })
})
