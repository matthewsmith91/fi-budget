import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCollapsedGroups, setCollapsedGroups } from './device-settings.ts'

function stubStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  })
  return items
}

describe('collapsed budget groups', () => {
  beforeEach(() => void stubStorage())
  afterEach(() => void vi.unstubAllGlobals())

  it('starts with every group open', () => {
    expect(getCollapsedGroups().size).toBe(0)
  })

  it('remembers what was folded away', () => {
    setCollapsedGroups(new Set(['bills', 'fun']))
    expect([...getCollapsedGroups()].sort()).toEqual(['bills', 'fun'])
  })

  it('ignores a value that is not a list of ids', () => {
    stubStorage({ 'budget-fi:collapsed-groups': '{"bills":true}' })
    expect(getCollapsedGroups().size).toBe(0)
    stubStorage({ 'budget-fi:collapsed-groups': '[1,"fun",null]' })
    expect([...getCollapsedGroups()]).toEqual(['fun'])
    stubStorage({ 'budget-fi:collapsed-groups': 'not json' })
    expect(getCollapsedGroups().size).toBe(0)
  })

  it('works when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(getCollapsedGroups().size).toBe(0)
    expect(() => setCollapsedGroups(new Set(['bills']))).not.toThrow()
  })
})
