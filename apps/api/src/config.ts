import { resolve } from 'node:path'

export interface Config {
  port: number
  /** Where the server's SQLite file lives; a mounted volume in Docker. */
  dataDir: string
  /** The built web app, served from the same origin as the API (passkeys require it). */
  staticDir: string
  /** Origins the web app is served from; a passkey is only valid on these. */
  origins: string[]
  /** The passkey relying-party ID: the hostname of the origins. */
  rpId: string
  /** Optional: with a key, imported payees can be sent to Claude for a category suggestion. */
  anthropicApiKey: string | null
  suggestModel: string | null
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = env.PORT === undefined || env.PORT === '' ? 3001 : Number(env.PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer from 0 to 65535, got "${env.PORT}"`)
  }
  // Outside production the app is reached through Vite (5173) or straight on the server's port.
  const origins = (env.ORIGIN || `http://localhost:5173,http://localhost:${port}`)
    .split(',')
    .map((origin) => parseOrigin(origin.trim()))
  const hosts = new Set(origins.map((origin) => new URL(origin).hostname))
  if (hosts.size !== 1) throw new Error('ORIGIN must list origins that share one hostname')
  return {
    port,
    dataDir: resolve(env.DATA_DIR || 'data'),
    // dist/ and src/ both sit beside ../../web in the monorepo and in the Docker image
    staticDir: resolve(env.STATIC_DIR || resolve(import.meta.dirname, '../../web/dist')),
    origins,
    rpId: [...hosts][0]!,
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    suggestModel: env.SUGGEST_MODEL || null,
  }
}

function parseOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`ORIGIN must be a URL like https://budget.example.com, got "${value}"`)
  }
  const secure = url.protocol === 'https:' || url.hostname === 'localhost'
  if (!secure) throw new Error(`ORIGIN must use https (passkeys require it), got "${value}"`)
  return url.origin
}
