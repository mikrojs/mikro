// Transport-agnostic HTTP request/response primitives. No dependency on
// `native:http`. Apps driving HTTP through a non-lwIP transport (e.g. an
// LTE modem over UART) implement the `Request` type directly and reuse
// `prepareBody` + `makeResponse` for the boring parts.

import {err, ok} from 'mikrojs/result'

import type {Result} from '../result/types.js'

export interface RequestOptions {
  method?: string
  /** Headers as pairs or a record. Keys used as-is (no implicit case change). */
  headers?: [string, string][] | Record<string, string>
  /** Raw body. */
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
   * Response body as an async iterable of byte chunks. Iteration yields
   * `Result<Uint8Array, RequestError>` so mid-stream failures (network
   * drop, abort, timeout) compose with the rest of the Result-based API.
   * Single-shot: after any of `body`, `text()`, `bytes()`, or `json()`
   * has started draining, the next consumer call throws
   * `BodyConsumedError`.
   */
  body: AsyncIterable<Result<Uint8Array, RequestError>>
  /** First matching header value, case-insensitive, or undefined if absent. */
  get(name: string): string | undefined
  /** All matching header values in order, case-insensitive. Empty array if absent. */
  getAll(name: string): string[]
  /** Drain body as a UTF-8 string. Throws `BodyConsumedError` on second consumer call. */
  text(): Promise<Result<string, RequestError>>
  /** Drain body and parse as JSON. Throws `BodyConsumedError` on second consumer call. */
  json(): Promise<Result<unknown, RequestError>>
  /** Drain body to a single `Uint8Array`. Throws `BodyConsumedError` on second consumer call. */
  bytes(): Promise<Result<Uint8Array, RequestError>>
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
  /** Body drained but JSON.parse rejected the payload. */
  InvalidJson: (message: string) => ({name: 'InvalidJson', message}) as const,
}

export type RequestError = ReturnType<(typeof RequestError)[keyof typeof RequestError]>

export class BodyConsumedError extends Error {
  readonly name = 'BodyConsumed'
  constructor() {
    super('response body already consumed')
  }
}

const textEncoder = new TextEncoder()

/**
 * Normalize `RequestOptions` into the byte-oriented shape a transport actually
 * sends: final body bytes (or null) and header pairs. UTF-8-encodes string
 * bodies.
 */
export function prepareBody(opts: RequestOptions): {
  body: Uint8Array | null
  headers: [string, string][]
} {
  const headers = normalizeHeaders(opts.headers)
  if (opts.body === undefined) return {body: null, headers}
  if (typeof opts.body === 'string') return {body: textEncoder.encode(opts.body), headers}
  return {body: opts.body, headers}
}

/**
 * Wrap a transport's raw response (Result-yielding async-iterable body) into
 * the public `Response` shape with `text()`/`json()`/`bytes()`/`get()`/
 * `getAll()`/`close()` and a single-shot body claim.
 */
export function makeResponse(raw: {
  status: number
  statusText: string
  url: string
  redirected: boolean
  headers: [string, string][]
  body: AsyncIterable<Result<Uint8Array, RequestError>>
}): Response {
  let consumed = false
  const claim = () => {
    if (consumed) throw new BodyConsumedError()
    consumed = true
  }

  const body: AsyncIterable<Result<Uint8Array, RequestError>> = {
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
      const text = await drainAsText(raw.body)
      if (!text.ok) return text
      try {
        return ok(JSON.parse(text.value))
      } catch (e) {
        return err(RequestError.InvalidJson(e instanceof Error ? e.message : String(e)))
      }
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

async function drain(
  source: AsyncIterable<Result<Uint8Array, RequestError>>,
): Promise<Result<Uint8Array, RequestError>> {
  const parts: Uint8Array[] = []
  let total = 0
  for await (const r of source) {
    if (!r.ok) return r
    parts.push(r.value)
    total += r.value.length
  }
  if (parts.length === 1) return ok(parts[0]!)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return ok(out)
}

async function drainAsText(
  source: AsyncIterable<Result<Uint8Array, RequestError>>,
): Promise<Result<string, RequestError>> {
  const decoder = new TextDecoder()
  let out = ''
  for await (const r of source) {
    if (!r.ok) return r
    out += decoder.decode(r.value, {stream: true})
  }
  out += decoder.decode()
  return ok(out)
}
