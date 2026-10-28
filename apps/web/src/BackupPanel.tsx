import { looksLikeSqlite } from '@budget-fi/core'
import { useState } from 'react'
import { budget } from './client.ts'
import { recordBackup } from './device-settings.ts'
import { downloadBlob, stamp } from './download.ts'

export function BackupPanel({ onChanged }: { onChanged: () => void }) {
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  async function run(fn: () => Promise<string>) {
    setMessage(null)
    try {
      setMessage({ text: await fn() })
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true })
    }
  }

  const exportJson = () =>
    run(async () => {
      downloadBlob(`budget-${stamp()}.json`, await budget.exportJson(), 'application/json')
      recordBackup()
      onChanged()
      return 'Exported budget as JSON.'
    })

  const exportSqlite = () =>
    run(async () => {
      downloadBlob(
        `budget-${stamp()}.sqlite`,
        (await budget.exportSqlite()) as Uint8Array<ArrayBuffer>,
        'application/vnd.sqlite3',
      )
      recordBackup()
      onChanged()
      return 'Exported budget as a SQLite file.'
    })

  const importFile = (file: File) =>
    run(async () => {
      const ok = confirm(
        'Importing replaces everything in this budget on this device. A backup of the current budget will download first. Continue?',
      )
      if (!ok) return 'Import cancelled.'
      const bytes = new Uint8Array(await file.arrayBuffer())
      const result = looksLikeSqlite(bytes)
        ? await budget.importSqlite(bytes)
        : await budget.importJson(new TextDecoder().decode(bytes))
      downloadBlob(
        `budget-before-import-${stamp()}.sqlite`,
        result.safetyBackup as Uint8Array<ArrayBuffer>,
        'application/vnd.sqlite3',
      )
      onChanged()
      return `Imported ${file.name}.`
    })

  return (
    <section>
      <h2>Backup</h2>
      <div className="row">
        <button onClick={() => void exportJson()}>Export JSON</button>
        <button onClick={() => void exportSqlite()}>Export SQLite</button>
      </div>
      <label className="file">
        Import a backup (JSON or SQLite)
        <input
          type="file"
          accept=".json,.sqlite,.sqlite3,.db,application/json"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void importFile(file)
          }}
        />
      </label>
      {message && (
        <p className={message.error ? 'error' : 'ok'} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </section>
  )
}
