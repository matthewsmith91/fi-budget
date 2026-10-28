import { describe, expect, it } from 'vitest'
import { backupReminderDue } from './backup.ts'

const now = new Date('2026-11-10T12:00:00Z')

describe('backupReminderDue', () => {
  it('is quiet right after install', () => {
    expect(backupReminderDue({ lastBackupAt: null, firstRunAt: '2026-11-10T00:00:00Z', now })).toBe(
      false,
    )
  })
  it('fires a week after install with no backup', () => {
    expect(backupReminderDue({ lastBackupAt: null, firstRunAt: '2026-11-03T12:00:00Z', now })).toBe(
      true,
    )
  })
  it('measures from the last backup when there is one', () => {
    const base = { firstRunAt: '2026-01-01T00:00:00Z', now }
    expect(backupReminderDue({ ...base, lastBackupAt: '2026-11-08T00:00:00Z' })).toBe(false)
    expect(backupReminderDue({ ...base, lastBackupAt: '2026-11-01T00:00:00Z' })).toBe(true)
  })
  it('treats unparseable dates as due', () => {
    expect(backupReminderDue({ lastBackupAt: 'garbage', firstRunAt: 'x', now })).toBe(true)
  })
})
