// Internal: native:mikro/http_server-backed server implementation. Bundled into
// http/server.js; not exposed as its own subpath. Exists as a seam so host
// tests can inject a fake native module (mirrors http/native.ts for the client).

import {makeResponse, RequestError} from 'mikro/http/helpers'
import {err, ok} from 'mikro/result'

import type {Result} from '../result/types.js'

/* Error returned by listen(). The native layer produces these via
 * mik__result_err_*, so the variant names must match mik_http_server.cpp. */
export const ServerError = {
  /** A server is already listening; close() before listening again. */
  AlreadyListening: () => ({name: 'AlreadyListening'}) as const,
  OutOfMemory: (message: string) => ({name: 'OutOfMemory', message}) as const,
  /** httpd_start failed (e.g. port unavailable). Message carries the esp_err. */
  StartFailed: (message: string) => ({name: 'StartFailed', message}) as const,
}
export type ServerError = ReturnType<(typeof ServerError)[keyof typeof ServerError]>

/**
 * Lazy, non-enumerable request header accessor. esp_http_server cannot list a
 * request's headers, so there is no full array — these fetch a header by name.
 * `getAll` returns `[value]` or `[]` (duplicate request headers collapse to one
 * on this platform).
 */
export interface RequestHeaders {
  get(name: string): string | undefined
  getAll(name: string): string[]
}

export interface ServerRequest {
  method: string
  /** Path plus query string, e.g. "/hello?x=1". */
  url: string
  headers: RequestHeaders
  /**
   * Request body as a single-shot async iterable of byte chunks (v1 buffers the
   * whole body up to `maxBodySize` before the handler runs). After any of
   * `body`/`text()`/`json()`/`bytes()` starts draining, the next consumer call
   * throws `BodyConsumedError`.
   */
  body: AsyncIterable<Result<Uint8Array, RequestError>>
  text(): Promise<Result<string, RequestError>>
  json(): Promise<Result<unknown, RequestError>>
  bytes(): Promise<Result<Uint8Array, RequestError>>
}

export interface ServerResponse {
  status: number
  headers?: [string, string][] | Record<string, string>
  body?: string | Uint8Array | AsyncIterable<Uint8Array | string>
}

export type Handler = (req: ServerRequest) => ServerResponse | Promise<ServerResponse>

/**
 * Called when a handler panics (throws or rejects) — an unexpected failure, not
 * the place for normal error handling. Receives the thrown value and the
 * request. Return a `ServerResponse` to send it; return nothing to fall back to
 * a plain 500. If the hook itself throws, the 500 fallback is used.
 */
export type PanicHandler = (
  error: unknown,
  req: ServerRequest,
) => ServerResponse | undefined | void | Promise<ServerResponse | undefined | void>

export interface ServerOptions {
  /** Cap on the buffered request body, in bytes (default 16 KiB). */
  maxBodySize?: number
  /** Hook invoked when a handler panics (throws). See {@link PanicHandler}. */
  onPanic?: PanicHandler
}

export interface Server {
  /** Bind and start serving. Synchronous; returns Err on bind failure. */
  listen(opts: {port: number}): Result<void, ServerError>
  /** Stop serving and release the port. Safe to call when not listening. */
  close(): void
}

export type CreateServer = (handler: Handler, opts?: ServerOptions) => Server

interface NativeRequestDescriptor {
  id: number
  method: string
  url: string
  body: Uint8Array
  bodyTooLarge: boolean
  contentLength: number
}

export interface NativeHttpServerModule {
  start: (port: number, maxBodySize?: number) => Result<void, ServerError>
  stop: () => void
  nextRequest: () => Promise<NativeRequestDescriptor | {closed: true}>
  /** One-shot response: status + headers + full body, sent with Content-Length. */
  respond: (id: number, status: number, headers: [string, string][], body?: Uint8Array) => void
  /** Begin a chunked (streamed) response. Resolves once status + headers are sent. */
  respondStart: (id: number, status: number, headers: [string, string][]) => Promise<void>
  /** Send one body chunk. Resolves to false if the client has gone (stop sending). */
  respondChunk: (id: number, data: Uint8Array) => Promise<boolean>
  /** Finish a chunked response. */
  respondEnd: (id: number) => void
  getHeader: (id: number, name: string) => string | undefined
}

const encoder = new TextEncoder()
const DEFAULT_MAX_BODY = 16384

/* ── Request / response plumbing ───────────────────────────────────── */

// CR, LF, and NUL in a header name or value could split the response or
// truncate it. esp_http_server stores header pointers verbatim and does not
// sanitize, so an app that reflects untrusted input into a header (e.g. a
// redirect Location) must not be able to inject headers through it.
const UNSAFE_HEADER_CHAR = /[\r\n\0]/

function normalizeHeaders(
  input: [string, string][] | Record<string, string> | undefined,
): [string, string][] {
  if (!input) return []
  const tuples: [string, string][] = Array.isArray(input)
    ? input
    : Object.keys(input).map((k) => [k, input[k]!])
  // Drop offending headers rather than throw: a throw here would leave the
  // httpd worker un-responded and hang the request.
  return tuples.filter(([k, v]) => !UNSAFE_HEADER_CHAR.test(k) && !UNSAFE_HEADER_CHAR.test(v))
}

function bodyIterable(
  desc: NativeRequestDescriptor,
  cap: number,
): AsyncIterable<Result<Uint8Array, RequestError>> {
  return {
    [Symbol.asyncIterator]() {
      let sent = false
      return {
        async next(): Promise<IteratorResult<Result<Uint8Array, RequestError>>> {
          if (sent) return {done: true, value: undefined}
          sent = true
          if (desc.bodyTooLarge) {
            return {done: false, value: err(RequestError.BodyTooLarge(desc.contentLength, cap))}
          }
          if (desc.body.length === 0) return {done: true, value: undefined}
          return {done: false, value: ok(desc.body)}
        },
      }
    },
  }
}

function makeServerRequest(
  native: NativeHttpServerModule,
  desc: NativeRequestDescriptor,
  cap: number,
): ServerRequest {
  // Borrow the client's single-shot body draining (text/json/bytes share one
  // consumed flag with body). Headers are NOT borrowed: esp_http_server can't
  // enumerate them, so they're lazy by-name lookups via native.getHeader.
  const drained = makeResponse({
    status: 0,
    statusText: '',
    url: desc.url,
    redirected: false,
    headers: [],
    body: bodyIterable(desc, cap),
  })
  return {
    method: desc.method,
    url: desc.url,
    headers: {
      get: (name) => native.getHeader(desc.id, name),
      getAll: (name) => {
        const v = native.getHeader(desc.id, name)
        return v === undefined ? [] : [v]
      },
    },
    body: drained.body,
    text: drained.text,
    json: drained.json,
    bytes: drained.bytes,
  }
}

async function streamResponse(
  native: NativeHttpServerModule,
  id: number,
  status: number,
  headers: [string, string][],
  body: AsyncIterable<Uint8Array | string>,
): Promise<void> {
  let started = false
  try {
    await native.respondStart(id, status, headers)
    started = true
    for await (const chunk of body) {
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
      if (bytes.length === 0) continue
      // respondChunk resolves once the chunk is flushed (backpressure); false
      // means the client disconnected, so stop pulling from the generator.
      if (!(await native.respondChunk(id, bytes))) break
    }
  } catch {
    // The generator threw after status + headers were already sent, so the
    // status can't change. End the response below to truncate it cleanly; the
    // server keeps running.
  } finally {
    // Only end a stream we actually started, so the worker is always released
    // exactly once.
    if (started) native.respondEnd(id)
  }
}

async function sendResponse(
  native: NativeHttpServerModule,
  id: number,
  response: ServerResponse,
): Promise<void> {
  const headers = normalizeHeaders(response.headers)
  const body = response.body
  if (body === undefined) {
    native.respond(id, response.status, headers, undefined)
  } else if (typeof body === 'string') {
    native.respond(id, response.status, headers, encoder.encode(body))
  } else if (body instanceof Uint8Array) {
    native.respond(id, response.status, headers, body)
  } else {
    await streamResponse(native, id, response.status, headers, body)
  }
}

const FALLBACK_500: ServerResponse = {status: 500, body: 'Internal Server Error'}

// A handler that panics (throws) is isolated to its one request so the server
// keeps serving: run the optional onPanic hook for a custom response (and
// server-side visibility), else send a plain 500. The httpd worker is blocked
// until we respond, so every branch must produce exactly one response.
async function handlePanic(
  onPanic: PanicHandler | undefined,
  error: unknown,
  req: ServerRequest,
): Promise<ServerResponse> {
  if (!onPanic) return FALLBACK_500
  try {
    return (await onPanic(error, req)) ?? FALLBACK_500
  } catch {
    // The hook itself threw; don't let its bug hang the worker.
    return FALLBACK_500
  }
}

async function serveLoop(
  native: NativeHttpServerModule,
  handler: Handler,
  isRunning: () => boolean,
  cap: number,
  onPanic: PanicHandler | undefined,
): Promise<void> {
  while (isRunning()) {
    let desc: NativeRequestDescriptor | {closed: true}
    try {
      desc = await native.nextRequest()
    } catch {
      break
    }
    if ('closed' in desc) break

    const req = makeServerRequest(native, desc, cap)
    // The whole per-request cycle (handler + send) is isolated so neither a
    // throwing handler nor a failed send can break the serve loop and stall
    // the server.
    try {
      let response: ServerResponse
      try {
        response = await handler(req)
      } catch (e) {
        response = await handlePanic(onPanic, e, req)
      }
      await sendResponse(native, desc.id, response)
    } catch {
      // Sending the response failed; the request is already past the point
      // where we can change it. Keep serving the next request.
    }
  }
}

export function createServerFromNative(native: NativeHttpServerModule): CreateServer {
  return (handler, opts = {}) => {
    const cap = opts.maxBodySize ?? DEFAULT_MAX_BODY
    let running = false
    return {
      listen({port}) {
        if (running) return err(ServerError.AlreadyListening())
        const started = native.start(port, opts.maxBodySize)
        if (!started.ok) return started
        running = true
        void serveLoop(native, handler, () => running, cap, opts.onPanic)
        return ok()
      },
      close() {
        if (!running) return
        running = false
        native.stop()
      },
    }
  }
}
