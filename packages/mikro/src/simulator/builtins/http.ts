import type {BuiltinDefinition} from './types.js'

// http delegates to Node's global fetch via the dev runner's RPC handler
// ('http.fetch'). The QuickJS-side stub keeps a per-request message queue so
// nextMessage() can deliver the body as one chunk followed by {kind: 'end'},
// matching the streaming contract that mikro/http expects from native:http.
export const httpBuiltin: BuiltinDefinition = {
  source: `/* eslint-disable no-console */
// Simulator stub for http
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {call} from 'native:host'
import {err, ok} from 'mikro/result'
import type {SimHttp} from 'mikro/sim'

let nextId = 0
const queues = new Map() // id -> message[]

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

// request() returns a discriminated union (not a Result) on success, so the
// outer object is a plain literal. The inner \`headers\` Promise resolves to a
// Result, which must use ok()/err() so consumers can call .orPanic / .map etc.
export const request: SimHttp['request'] = (url, options) => {
  console.log('[sim] http.request:', options?.method ?? 'GET', url)
  const id = nextId++
  const queue: any[] = []
  queues.set(id, queue)

  const args = JSON.stringify({
    url,
    method: options?.method,
    headers: options?.headers,
    body: options?.body ? bytesToBase64(options.body) : undefined,
  })

  const headers = call('http.fetch', args).then(
    (json: string) => {
      const r = JSON.parse(json) as {status: number; headers: [string, string][]; body: string}
      const body = base64ToBytes(r.body)
      if (body.length > 0) queue.push({kind: 'chunk', data: body})
      queue.push({kind: 'end'})
      return ok({status: r.status, headers: r.headers})
    },
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e)
      queue.push({kind: 'error', cancelled: false, message})
      return err({name: 'Network', message})
    },
  )

  return {ok: true as const, id, headers}
}

// Polls the queue every microtask until a message is available. The queue is
// populated when the RPC promise settles, so the first poll is fast in
// practice; this avoids needing an explicit wakeup channel.
export const nextMessage: SimHttp['nextMessage'] = async (id) => {
  for (;;) {
    const queue = queues.get(id)
    if (!queue) return {kind: 'end' as const}
    if (queue.length > 0) {
      const msg = queue.shift()
      if (msg.kind === 'end' || msg.kind === 'error') queues.delete(id)
      return msg
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

export const cancel: SimHttp['cancel'] = (id) => {
  const queue = queues.get(id)
  if (queue) {
    queue.length = 0
    queue.push({kind: 'error', cancelled: true, message: 'cancelled'})
  }
}

export const pendingCount: SimHttp['pendingCount'] = () => queues.size
`,
}
