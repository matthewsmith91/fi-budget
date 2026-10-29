/** The server is the only thing here that can be missing: the budget itself works without it. */
export class ServerUnavailableError extends Error {
  constructor() {
    super('The sync server cannot be reached')
  }
}

/** GET with no body, POST with one; `method` overrides (DELETE). */
export async function request<T>(url: string, body?: unknown, method?: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ServerUnavailableError()
  }
  if (res.status === 204) return undefined as T
  // A static host (or the dev server with no API) answers /api with the app shell, not JSON.
  if (!res.headers.get('content-type')?.includes('application/json')) {
    throw new ServerUnavailableError()
  }
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`)
  return json
}
