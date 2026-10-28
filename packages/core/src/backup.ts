export const DEFAULT_BACKUP_REMINDER_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Local-only devices should nag about backups. With no backup yet, the clock starts
 * at the device's first run so a brand-new install isn't nagged immediately.
 */
export function backupReminderDue(
  opts: { lastBackupAt: string | null; firstRunAt: string; now: Date },
  days = DEFAULT_BACKUP_REMINDER_DAYS,
): boolean {
  const since = Date.parse(opts.lastBackupAt ?? opts.firstRunAt)
  if (Number.isNaN(since)) return true
  return opts.now.getTime() - since >= days * DAY_MS
}
