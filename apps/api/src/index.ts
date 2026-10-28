import { createApp } from './app.ts'
import { ensureSetupInvite } from './auth.ts'
import { loadConfig } from './config.ts'
import { DB_FILE, openDatabase } from './db.ts'
import { join } from 'node:path'

const config = loadConfig()
const db = openDatabase(join(config.dataDir, DB_FILE))
const app = createApp({
  db,
  staticDir: config.staticDir,
  auth: { rpId: config.rpId, origins: config.origins },
})

// Until the first person registers there is nobody to hand out a pairing code, so print one.
const setupCode = ensureSetupInvite(db, Date.now())
if (setupCode) {
  console.log(`No one has signed up yet. Open ${config.origins[0]} and use setup code ${setupCode}`)
}

const server = app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port} (data in ${config.dataDir})`)
})

// Docker sends SIGTERM; finish in-flight requests and close the database cleanly (WAL checkpoint).
function shutdown() {
  server.close(() => {
    db.close()
    process.exit(0)
  })
  server.closeIdleConnections()
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
