import { useState } from 'react'
import type { ServiceWorkerState } from './hooks.ts'
import { releasesPage } from './update.ts'

const CURRENT = __APP_VERSION__

type CheckResult = { kind: 'current'; at: Date } | { kind: 'offline' } | { kind: 'failed' }

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * The version running here, and a new one only when the app itself changed: the service worker
 * finds new app files on the household's server (hourly, on every full load, or on Check for
 * updates) and they wait for "Update now". Nothing here looks at GitHub, so a release that only
 * changes the server never shows up on a device.
 */
export function UpdateCard({ sw }: { sw: ServiceWorkerState }) {
  const [result, setResult] = useState<CheckResult | null>(null)
  const [checking, setChecking] = useState(false)

  async function check() {
    if (checking) return
    if (!navigator.onLine) {
      setResult({ kind: 'offline' })
      return
    }
    setChecking(true)
    setResult(null)
    try {
      // 'ready' needs no message of its own: needRefresh flips and the card offers Update now
      if ((await sw.checkServer()) === 'current') setResult({ kind: 'current', at: new Date() })
    } catch {
      setResult({ kind: 'failed' })
    } finally {
      setChecking(false)
    }
  }

  let status: React.ReactNode = null
  if (sw.needRefresh) {
    status = <p>A new version is ready.</p>
  } else if (checking) {
    status = <p className="muted">Checking for updates…</p>
  } else if (result?.kind === 'current') {
    status = (
      <p>
        Up to date. <span className="muted">Checked at {timeFormat.format(result.at)}.</span>
      </p>
    )
  } else if (result?.kind === 'offline') {
    status = <p className="muted">You’re offline. Connect to check for updates.</p>
  } else if (result?.kind === 'failed') {
    status = <p className="muted">Couldn’t reach your server to check for updates.</p>
  }

  return (
    <section className="card" aria-labelledby="app-updates">
      <h2 id="app-updates">Updates</h2>
      <p>
        Version {CURRENT} ·{' '}
        <a href={releasesPage} target="_blank" rel="noopener noreferrer">
          Release notes
        </a>
      </p>
      <div role="status">{status}</div>
      {sw.needRefresh ? (
        <div className="row update-actions">
          <button type="button" onClick={sw.applyUpdate}>
            Update now
          </button>
        </div>
      ) : (
        sw.canCheck && (
          <div className="row update-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => void check()}
              aria-disabled={checking}
            >
              Check for updates
            </button>
          </div>
        )
      )}
    </section>
  )
}
