/**
 * The one message API between the UI and the worker. Every call is
 * `{ id, method, params }` and is answered by exactly one `{ id, ok, ... }`.
 * Anything with `postMessage` and `onmessage` works: a Worker, a MessagePort, or
 * the worker's own global scope.
 */
export interface Endpoint {
  postMessage(message: unknown): void
  onmessage: MessageHandler | null
}

// method-style so a DOM Worker/MessagePort (whose handler takes a full MessageEvent) fits
type MessageHandler = { bivarianceHack(event: { data: unknown }): void }['bivarianceHack']

export interface RpcRequest {
  id: number
  method: string
  params: unknown[]
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string } }

export type RpcMethods = { [name: string]: (...params: any[]) => Promise<unknown> }

/** Answers requests on `endpoint`. `api` may still be loading; requests wait for it. */
export function serve(api: RpcMethods | Promise<RpcMethods>, endpoint: Endpoint): void {
  const ready = Promise.resolve(api)
  endpoint.onmessage = (event) => {
    const req = event.data as RpcRequest
    if (typeof req?.id !== 'number' || typeof req.method !== 'string') return
    void ready
      .then(async (methods) => {
        if (!Object.hasOwn(methods, req.method)) throw new Error(`Unknown method: ${req.method}`)
        return methods[req.method]!(...(Array.isArray(req.params) ? req.params : []))
      })
      .then(
        (result): RpcResponse => ({ id: req.id, ok: true, result }),
        (err: unknown): RpcResponse => ({
          id: req.id,
          ok: false,
          error: {
            name: err instanceof Error ? err.name : 'Error',
            message: err instanceof Error ? err.message : String(err),
          },
        }),
      )
      .then((res) => endpoint.postMessage(res))
  }
}

export class RpcError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

/** Returns a typed proxy: `client.getStatus()` becomes a request/response round trip. */
export function connect<A extends RpcMethods>(endpoint: Endpoint): A {
  let nextId = 1
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  endpoint.onmessage = (event) => {
    const res = event.data as RpcResponse
    const waiter = pending.get(res?.id)
    if (!waiter) return
    pending.delete(res.id)
    if (res.ok) waiter.resolve(res.result)
    else waiter.reject(new RpcError(res.error.name, res.error.message))
  }
  return new Proxy({} as A, {
    get: (_target, method) => {
      if (typeof method !== 'string' || method === 'then') return undefined
      return (...params: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = nextId++
          pending.set(id, { resolve, reject })
          endpoint.postMessage({ id, method, params } satisfies RpcRequest)
        })
    },
  })
}
