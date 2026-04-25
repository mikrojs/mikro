// Transport-agnostic HTTP request/response primitives. No dependency on
// `native:http`. Apps driving HTTP through a non-lwIP transport (e.g. an
// LTE modem over UART) implement the `Request` type directly and reuse
// `prepareBody` + `makeResponse` for the boring parts.

import type {Result} from 'mikrojs/result'

export interface RequestOptions {
  method?: string
  /** Headers as pairs or a record. Keys used as-is (no implicit case change). */
  headers?: [string, string][] | Record<string, string>
  /** Shortcut: stringify as JSON and set `content-type: application/json`. */
  json?: unknown
  /** Raw body. Mutually exclusive with `json`. */
  body?: Uint8Array | string
  /** Total wallclock deadline; transport enforces. */
  timeoutMs?: number
  /** Transport owns listener install + cleanup. Maps abort to RequestError.Aborted. */
  signal?: AbortSignal
}

export interface Response {
  status: number
  statusText: string
  url: string
  redirected: boolean
  headers: [string, string][]
  ok: boolean
  /**
   * Response body as an async iterable of chunks. Single-shot: after any of
   * `body`, `text()`, `bytes()`, or `json()` has started draining, calling
   * another consumer throws `BodyConsumedError`.
   */
  body: AsyncIterable<Uint8Array>
  /** First matching header value, case-insensitive, or undefined if absent. */
  get(name: string): string | undefined
  /** All matching header values in order, case-insensitive. Empty array if absent. */
  getAll(name: string): string[]
  /** Drain body as a UTF-8 string. Throws `BodyConsumedError` on second consumer call. */
  text(): Promise<string>
  /** Drain body and parse as JSON. Throws `BodyConsumedError` on second consumer call. */
  json(): Promise<unknown>
  /** Drain body to a single `Uint8Array`. Throws `BodyConsumedError` on second consumer call. */
  bytes(): Promise<Uint8Array>
  /**
   * Cancel the request and release any native resources. Safe to call after
   * the body has been consumed (no-op). Safe to call multiple times.
   */
  close(): Promise<void>
}

export type Request = (
  url: string,
  options?: RequestOptions,
) => Promise<Result<Response, RequestError>>

export const RequestError = {
  Hardware: (message: string) => ({name: 'Hardware', message}) as const,
  Network: (message: string) => ({name: 'Network', message}) as const,
  Timeout: (message: string) => ({name: 'Timeout', message}) as const,
  /** Request body exceeded the transport's per-request cap. */
  BodyTooLarge: (size: number, cap: number) => ({name: 'BodyTooLarge', size, cap}) as const,
  /** Transport returned bytes that could not be parsed as an HTTP response. */
  InvalidResponse: (message: string) => ({name: 'InvalidResponse', message}) as const,
  Aborted: (message: string) => ({name: 'Aborted', message}) as const,
  /** Transport is at its concurrent-request cap. Retry after in-flight requests settle. */
  TooManyPending: () => ({name: 'TooManyPending'}) as const,
}

export type RequestError =
  | ReturnType<typeof RequestError.Hardware>
  | ReturnType<typeof RequestError.Network>
  | ReturnType<typeof RequestError.Timeout>
  | ReturnType<typeof RequestError.BodyTooLarge>
  | ReturnType<typeof RequestError.InvalidResponse>
  | ReturnType<typeof RequestError.Aborted>
  | ReturnType<typeof RequestError.TooManyPending>

export class BodyConsumedError extends Error {
  readonly name = 'BodyConsumed'
  constructor() {
    super('response body already consumed')
  }
}

const textEncoder = new TextEncoder()

/**
 * Normalize `RequestOptions` into the byte-oriented shape a transport actually
 * sends: final body bytes (or null) and header pairs. Applies the `json`
 * shortcut (encodes + sets content-type unless already present) and
 * UTF-8-encodes string bodies.
 */
export function prepareBody(opts: RequestOptions): {
  body: Uint8Array | null
  headers: [string, string][]
} {
  const headers = normalizeHeaders(opts.headers)
  if (opts.json !== undefined) {
    if (!hasHeader(headers, 'content-type')) {
      headers.push(['content-type', 'application/json'])
    }
    return {body: textEncoder.encode(JSON.stringify(opts.json)), headers}
  }
  if (opts.body === undefined) return {body: null, headers}
  if (typeof opts.body === 'string') return {body: textEncoder.encode(opts.body), headers}
  return {body: opts.body, headers}
}

/**
 * Wrap a transport's raw response (async-iterable body) into the public
 * `Response` shape with `text()`/`json()`/`bytes()`/`get()`/`getAll()`/`close()`
 * and a single-shot body claim.
 */
export function makeResponse(raw: {
  status: number
  statusText: string
  url: string
  redirected: boolean
  headers: [string, string][]
  body: AsyncIterable<Uint8Array>
}): Response {
  let consumed = false
  const claim = () => {
    if (consumed) throw new BodyConsumedError()
    consumed = true
  }

  const body: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      claim()
      return raw.body[Symbol.asyncIterator]()
    },
  }

  return {
    status: raw.status,
    statusText: raw.statusText,
    url: raw.url,
    redirected: raw.redirected,
    headers: raw.headers,
    ok: raw.status >= 200 && raw.status < 300,
    body,
    get: (name) => {
      const lower = name.toLowerCase()
      for (const [k, v] of raw.headers) {
        if (k.toLowerCase() === lower) return v
      }
      return undefined
    },
    getAll: (name) => {
      const lower = name.toLowerCase()
      const out: string[] = []
      for (const [k, v] of raw.headers) {
        if (k.toLowerCase() === lower) out.push(v)
      }
      return out
    },
    text: async () => {
      claim()
      return await drainAsText(raw.body)
    },
    json: async () => {
      claim()
      return JSON.parse(await drainAsText(raw.body))
    },
    bytes: async () => {
      claim()
      return await drain(raw.body)
    },
    close: async () => {
      consumed = true
      const it = raw.body[Symbol.asyncIterator]()
      if (it.return) await it.return()
    },
  }
}

function normalizeHeaders(
  input: [string, string][] | Record<string, string> | undefined,
): [string, string][] {
  if (!input) return []
  if (Array.isArray(input)) return input.map(([k, v]) => [k, v])
  const out: [string, string][] = []
  for (const key of Object.keys(input)) out.push([key, input[key]!])
  return out
}

function hasHeader(headers: [string, string][], name: string): boolean {
  const lower = name.toLowerCase()
  for (const [k] of headers) {
    if (k.toLowerCase() === lower) return true
  }
  return false
}

async function drain(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  for await (const chunk of source) {
    parts.push(chunk)
    total += chunk.length
  }
  if (parts.length === 1) return parts[0]!
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

async function drainAsText(source: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let out = ''
  for await (const chunk of source) {
    out += decoder.decode(chunk, {stream: true})
  }
  out += decoder.decode()
  return out
}
