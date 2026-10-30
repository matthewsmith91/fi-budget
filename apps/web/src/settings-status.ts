import { backupReminderDue } from '@budget-fi/core'
import { describeSync, type SyncView } from './sync-state.ts'
import type { PersistState } from './hooks.ts'

/** One line of the "Your data" card: what is true, and where to go if it is a problem. */
export interface StatusRow {
  label: string
  text: string
  /** `warn` rows are data-loss risks and get the warning colour. */
  tone: 'ok' | 'warn' | 'neutral'
  action?: { label: string; href: string }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** `today`, `yesterday`, `3 days ago`, then the date once it is a few weeks old. */
export function daysAgo(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS)
  if (Number.isNaN(days)) return 'on an unknown date'
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 28) return `${days} days ago`
  return `on ${new Date(iso).toLocaleDateString()}`
}

export function storageRow(storage: 'opfs' | 'memory' | undefined): StatusRow {
  const label = 'Storage'
  if (!storage) return { label, text: 'Checking…', tone: 'neutral' }
  if (storage === 'memory')
    return {
      label,
      text: 'Not saved. Everything is lost when you close this tab.',
      tone: 'warn',
      action: { label: 'Export a backup', href: '#/settings/backups' },
    }
  return { label, text: 'Saved on this device', tone: 'ok' }
}

export function protectionRow(persist: PersistState): StatusRow {
  const label = 'Kept by browser'
  switch (persist) {
    case 'granted':
      return { label, text: 'Your browser won’t clear this data to free up space', tone: 'ok' }
    case 'denied':
      return {
        label,
        text: 'Your browser may clear this data when space runs low. Install the app to your home screen and back up regularly.',
        tone: 'warn',
        action: { label: 'Export a backup', href: '#/settings/backups' },
      }
    case 'unsupported':
      return {
        label,
        text: 'This browser can’t promise to keep your data. Back up regularly.',
        tone: 'warn',
        action: { label: 'Export a backup', href: '#/settings/backups' },
      }
    case 'unknown':
      return { label, text: 'Checking…', tone: 'neutral' }
  }
}

export function backupRow(
  backup: { lastBackupAt: string | null; firstRunAt: string },
  now: Date,
): StatusRow {
  const label = 'Last backup'
  const due = backupReminderDue({ ...backup, now })
  const when = backup.lastBackupAt ? daysAgo(backup.lastBackupAt, now) : null
  const text = when ? `${when[0]!.toUpperCase()}${when.slice(1)}` : 'Never'
  return {
    label,
    text,
    // a check mark on "Never" would read as a pass; a new install is just not due yet
    tone: due ? 'warn' : backup.lastBackupAt ? 'ok' : 'neutral',
    action: { label: due ? 'Export a backup' : 'Backups', href: '#/settings/backups' },
  }
}

/** What the Sync row shows. It reads the same view as the banner, so the two never disagree. */
export interface SyncSummary {
  view: SyncView | null
  loaded: boolean
  failed: boolean
}

export function syncRow({ view, loaded, failed }: SyncSummary, now: Date): StatusRow {
  const label = 'Sync'
  if (failed) return { label, text: 'Couldn’t read the sync status', tone: 'warn' }
  if (!loaded) return { label, text: 'Checking…', tone: 'neutral' }
  if (!view)
    return {
      label,
      text: 'Off. This budget only exists on this device.',
      tone: 'neutral',
      action: { label: 'Set up sync', href: '#/settings/household' },
    }
  switch (view.kind) {
    case 'synced':
      return {
        label,
        text: view.lastSyncAt ? `Synced ${daysAgo(view.lastSyncAt, now)}` : 'Synced',
        tone: 'ok',
      }
    case 'signin':
      return {
        label,
        text: describeSync(view),
        tone: 'warn',
        action: { label: 'Sign in', href: '#/settings/household' },
      }
    case 'error':
      return { label, text: describeSync(view), tone: 'warn' }
    case 'syncing':
    case 'offline':
    case 'unsynced':
      return { label, text: describeSync(view), tone: 'neutral' }
  }
}

/** Only worth a row until it is ready; after that it is not news. */
export function offlineRow(offlineReady: boolean): StatusRow | null {
  if (offlineReady) return null
  return {
    label: 'Offline use',
    text: 'Still getting ready to work without a connection',
    tone: 'neutral',
  }
}
