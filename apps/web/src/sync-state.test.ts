import { describe, expect, it } from 'vitest'
import { changeCount, shouldAutoSync, syncView, type SyncInputs } from './sync-state.ts'

const linked = { linked: true, pending: 0, lastSyncAt: '2026-10-28T12:00:00.000Z' }
const base: SyncInputs = { status: linked, online: true, syncing: false, error: null }

describe('syncView', () => {
  it('shows nothing on a device that does not sync', () => {
    expect(syncView({ ...base, status: { ...linked, linked: false } })).toBeNull()
    expect(syncView({ ...base, status: undefined })).toBeNull()
  })

  it('is synced when nothing is pending', () => {
    expect(syncView(base)).toEqual({ kind: 'synced', lastSyncAt: linked.lastSyncAt })
  })

  it('counts changes the server does not have yet', () => {
    expect(syncView({ ...base, status: { ...linked, pending: 3 } })).toEqual({
      kind: 'unsynced',
      pending: 3,
    })
  })

  it('says offline when the browser is offline or the server cannot be reached', () => {
    const status = { ...linked, pending: 2 }
    expect(syncView({ ...base, status, online: false })).toEqual({ kind: 'offline', pending: 2 })
    expect(syncView({ ...base, status, error: 'Could not reach the server' })).toEqual({
      kind: 'offline',
      pending: 2,
    })
  })

  it('asks to sign in, and shows other failures as they are', () => {
    expect(syncView({ ...base, error: 'Sign in to sync' })?.kind).toBe('signin')
    expect(syncView({ ...base, error: 'The server refused the sync (500)' })).toEqual({
      kind: 'error',
      pending: 0,
      message: 'The server refused the sync (500)',
    })
  })

  it('shows syncing over everything else', () => {
    expect(syncView({ ...base, syncing: true, online: false, error: 'x' })?.kind).toBe('syncing')
  })
})

describe('shouldAutoSync', () => {
  it('only tries when changes are waiting and nothing is wrong', () => {
    expect(shouldAutoSync(syncView({ ...base, status: { ...linked, pending: 1 } }))).toBe(true)
    expect(shouldAutoSync(syncView(base))).toBe(false)
    expect(
      shouldAutoSync(syncView({ ...base, status: { ...linked, pending: 1 }, online: false })),
    ).toBe(false)
    expect(
      shouldAutoSync(syncView({ ...base, status: { ...linked, pending: 1 }, error: 'boom' })),
    ).toBe(false)
  })
})

describe('changeCount', () => {
  it('pluralises', () => {
    expect(changeCount(1)).toBe('1 change')
    expect(changeCount(4)).toBe('4 changes')
  })
})
