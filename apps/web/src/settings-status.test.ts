import { describe, expect, it } from 'vitest'
import {
  backupRow,
  daysAgo,
  offlineRow,
  protectionRow,
  storageRow,
  syncRow,
} from './settings-status.ts'

const now = new Date('2026-10-29T12:00:00.000Z')

describe('daysAgo', () => {
  it('speaks in days, then falls back to a date', () => {
    expect(daysAgo('2026-10-29T01:00:00.000Z', now)).toBe('today')
    expect(daysAgo('2026-10-28T01:00:00.000Z', now)).toBe('yesterday')
    expect(daysAgo('2026-10-24T12:00:00.000Z', now)).toBe('5 days ago')
    expect(daysAgo('2026-08-01T12:00:00.000Z', now)).toMatch(/^on /)
    expect(daysAgo('nonsense', now)).toBe('on an unknown date')
  })
})

describe('storageRow', () => {
  it('warns when the budget only lives in memory', () => {
    expect(storageRow('memory')).toMatchObject({ tone: 'warn' })
    expect(storageRow('memory').action?.href).toBe('#/settings/backups')
  })

  it('is calm on durable storage and neutral while loading', () => {
    expect(storageRow('opfs')).toMatchObject({ text: 'Saved on this device', tone: 'ok' })
    expect(storageRow(undefined).tone).toBe('neutral')
  })
})

describe('protectionRow', () => {
  it('warns when the browser may evict the data', () => {
    expect(protectionRow('denied').tone).toBe('warn')
    expect(protectionRow('unsupported').tone).toBe('warn')
  })

  it('is ok when granted and neutral while unknown', () => {
    expect(protectionRow('granted').tone).toBe('ok')
    expect(protectionRow('unknown').tone).toBe('neutral')
  })
})

describe('backupRow', () => {
  const firstRunAt = '2026-01-01T00:00:00.000Z'

  it('warns when there has never been a backup and the reminder is due', () => {
    expect(backupRow({ lastBackupAt: null, firstRunAt }, now)).toMatchObject({
      text: 'Never',
      tone: 'warn',
      action: { label: 'Export a backup' },
    })
  })

  it('does not nag about a brand-new install', () => {
    const fresh = { lastBackupAt: null, firstRunAt: '2026-10-28T00:00:00.000Z' }
    expect(backupRow(fresh, now)).toMatchObject({ text: 'Never', tone: 'neutral' })
  })

  it('shows how long ago, warning once the reminder is due', () => {
    expect(backupRow({ lastBackupAt: '2026-10-27T12:00:00.000Z', firstRunAt }, now)).toMatchObject({
      text: '2 days ago',
      tone: 'ok',
    })
    expect(backupRow({ lastBackupAt: '2026-10-01T12:00:00.000Z', firstRunAt }, now).tone).toBe(
      'warn',
    )
  })
})

describe('syncRow', () => {
  const synced = {
    view: { kind: 'synced', lastSyncAt: '2026-10-29T10:00:00.000Z' } as const,
    loaded: true,
    failed: false,
  }

  it('says sync is off on a device that does not sync, with a way to turn it on', () => {
    const row = syncRow({ view: null, loaded: true, failed: false }, now)
    expect(row.text).toMatch(/^Off/)
    expect(row.action?.href).toBe('#/settings/household')
  })

  it('says when it last synced', () => {
    expect(syncRow(synced, now)).toMatchObject({ text: 'Synced today', tone: 'ok' })
  })

  it('never claims to be up to date when the banner says otherwise', () => {
    const signedOut = syncRow({ ...synced, view: { kind: 'signin', pending: 2 } }, now)
    expect(signedOut).toMatchObject({ tone: 'warn', action: { label: 'Sign in' } })
    expect(signedOut.text).toBe(
      'Signed out of the server, so changes aren’t syncing (2 changes waiting).',
    )
    expect(
      syncRow({ ...synced, view: { kind: 'error', pending: 0, message: 'boom' } }, now),
    ).toMatchObject({
      text: 'Couldn’t sync: boom',
      tone: 'warn',
    })
    expect(syncRow({ ...synced, view: { kind: 'offline', pending: 0 } }, now).tone).toBe('neutral')
    expect(syncRow({ ...synced, view: { kind: 'unsynced', pending: 1 } }, now).text).toBe(
      '1 change not yet synced.',
    )
  })

  it('reports a status that failed to load, and waits for one that has not', () => {
    expect(syncRow({ view: null, loaded: false, failed: true }, now).tone).toBe('warn')
    expect(syncRow({ view: null, loaded: false, failed: false }, now).tone).toBe('neutral')
  })
})

describe('offlineRow', () => {
  it('only speaks up until the service worker is ready', () => {
    expect(offlineRow(true)).toBeNull()
    expect(offlineRow(false)?.tone).toBe('neutral')
  })
})
