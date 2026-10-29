import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import express, { type ErrorRequestHandler, type Express } from 'express'
import { AuthError } from './auth.ts'
import { createAuthRouter, sameOriginOnly } from './auth-routes.ts'
import { createBankRouter } from './bank.ts'
import { schemaVersion } from './db.ts'
import type { Fetch } from './simplefin.ts'
import { createSuggestRouter, type SuggestDeps } from './suggest.ts'
import { createSyncRouter } from './sync.ts'

export interface AppDeps {
  db: DatabaseSync
  staticDir: string
  /** Passkey settings: the hostname people sign in on and the origins that may do so. */
  auth: { rpId: string; origins: string[]; now?: () => number }
  /** Seals bank credentials at rest; `fetch` is replaced in tests so they never reach SimpleFIN. */
  bank: { key: Buffer; fetch?: Fetch }
  /** Category suggestions: the key can also come from the environment, and tests replace the network. */
  suggest?: Pick<SuggestDeps, 'env' | 'make' | 'check'>
}

const apiErrors: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message })
  } else if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
    res.status(400).json({ error: 'Invalid request body' })
  } else {
    console.error(error)
    res.status(500).json({ error: 'Something went wrong' })
  }
}

export function createApp({ db, staticDir, auth, bank, suggest }: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  // A sync batch is bigger than the default body limit; this parser runs first and the
  // general one below skips a body that is already parsed.
  app.use('/api/sync', express.json({ limit: '2mb' }))
  app.use(express.json())

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
    })
    next()
  })

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', schemaVersion: schemaVersion(db) })
  })

  app.use('/api', sameOriginOnly(auth.origins))
  app.use('/api/auth', createAuthRouter({ db, rpName: 'Household Budget', ...auth }))

  app.use('/api/sync', createSyncRouter({ db, now: auth.now }))
  app.use('/api/bank', createBankRouter({ db, now: auth.now, ...bank }))
  app.use('/api/suggest', createSuggestRouter({ db, key: bank.key, now: auth.now, ...suggest }))

  // Everything under /api is server-owned; an unknown path must not fall through to the app shell.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })
  app.use('/api', apiErrors)

  const indexHtml = join(staticDir, 'index.html')
  if (existsSync(indexHtml)) {
    app.use(
      express.static(staticDir, {
        index: false,
        setHeaders(res, path) {
          // Hashed bundles never change; everything else (index.html, sw.js, manifest) must
          // revalidate or a stale service worker would pin devices to an old version.
          const immutable = path.includes(`${join(staticDir, 'assets')}/`)
          res.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
        },
      }),
    )
    // Single-page app: any other GET is a client-side route.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next()
      res.set('Cache-Control', 'no-cache')
      res.sendFile(indexHtml)
    })
  }

  return app
}
