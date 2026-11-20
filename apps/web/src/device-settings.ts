/**
 * Per-device settings. These deliberately live outside the budget file: they describe
 * this browser (when it last backed up), not the household, so they must never sync.
 */
const KEY_FIRST_RUN = 'budget-fi:first-run-at'
const KEY_LAST_BACKUP = 'budget-fi:last-backup-at'
const KEY_COLLAPSED_GROUPS = 'budget-fi:collapsed-groups'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage blocked; the reminder just falls back to "due"
  }
}

export function getBackupState(now = new Date()): {
  firstRunAt: string
  lastBackupAt: string | null
} {
  let firstRunAt = read(KEY_FIRST_RUN)
  if (!firstRunAt) {
    firstRunAt = now.toISOString()
    write(KEY_FIRST_RUN, firstRunAt)
  }
  return { firstRunAt, lastBackupAt: read(KEY_LAST_BACKUP) }
}

export function recordBackup(now = new Date()): void {
  write(KEY_LAST_BACKUP, now.toISOString())
}

/** Category groups folded away in the budget on this device; each person folds their own. */
export function getCollapsedGroups(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(read(KEY_COLLAPSED_GROUPS) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

export function setCollapsedGroups(ids: ReadonlySet<string>): void {
  write(KEY_COLLAPSED_GROUPS, JSON.stringify([...ids]))
}

const KEY_LAST_SEEN_VERSION = 'budget-fi:last-seen-version'

/**
 * The app version this device last opened, then records `current` as seen. Returns null on a
 * first run (nothing to announce), so "What's new" shows once per device per update.
 */
export function takeLastSeenVersion(current: string): string | null {
  const last = read(KEY_LAST_SEEN_VERSION)
  if (last !== current) write(KEY_LAST_SEEN_VERSION, current)
  return last
}
