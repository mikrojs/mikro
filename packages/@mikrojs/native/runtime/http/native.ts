// Internal: native:http-backed request implementation. Bundled into
// http/request.js; not exposed as its own subpath. Exists as a seam so host
// tests can inject a fake native module.

import {
  makeResponse,
  prepareBody,
  type Request,
  RequestError,
  type RequestOptions,
} from 'mikro/http/helpers'
import {err, ok} from 'mikro/result'

import type {ErrResult, Result} from '../result/types.js'

type HttpRequestStart =
  | {
      ok: true
      id: number
      headers: Promise<Result<{status: number; headers: [string, string][]}, RequestError>>
    }
  | ErrResult<RequestError>

export interface NativeHttpModule {
  request: (
    url: string,
    options?: {method?: string; body?: Uint8Array; headers?: [string, string][]},
  ) => HttpRequestStart
  nextMessage: (
    id: number,
  ) => Promise<
    | {kind: 'chunk'; data: Uint8Array}
    | {kind: 'end'}
    | {kind: 'error'; cancelled: boolean; message: string}
  >
  cancel: (id: number) => void
  pendingCount: () => number
}

/**
 * Build a `Request` function driven by a `native:http`-shaped module. Owns
 * AbortSignal listener lifecycle and total-wallclock timeout enforcement.
 *
 * Callers are responsible for releasing the native pending slot by either
 * draining the response body or calling `response.close()`. Leaks are
 * observable via `pendingCount()`.
 */
export function createRequestFromNative(native: NativeHttpModule): Request {
  return async (url: string, options: RequestOptions = {}) => {
    if (options.signal?.aborted) {
      return err(RequestError.Aborted(String(options.signal.reason ?? 'aborted')))
    }

    const {body, headers} = prepareBody(options)
    const method = (options.method ?? 'GET').toUpperCase()

    const start = native.request(url, {
      method,
      body: body ?? undefined,
      headers,
    })
    if (!start.ok) return start

    const id = start.id

    let cleaned = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let abortHandler: (() => void) | undefined
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler)
      }
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }

    if (options.timeoutMs !== undefined) {
      timeoutId = setTimeout(() => native.cancel(id), options.timeoutMs)
    }
    if (options.signal) {
      abortHandler = () => native.cancel(id)
      options.signal.addEventListener('abort', abortHandler)
    }

    const headersResult = await start.headers
    if (!headersResult.ok) {
      cleanup()
      return headersResult
    }

    const {status, headers: responseHeaders} = headersResult.value

    let done = false
    const rawBody: AsyncIterable<Result<Uint8Array, RequestError>> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Result<Uint8Array, RequestError>>> {
            if (done) return {done: true, value: undefined}
            let msg
            try {
              msg = await native.nextMessage(id)
            } catch (e) {
              done = true
              cleanup()
              const message = e instanceof Error ? e.message : String(e)
              return {done: false, value: err(RequestError.Network(message))}
            }
            if (msg.kind === 'chunk') {
              return {done: false, value: ok(msg.data)}
            }
            done = true
            cleanup()
            if (msg.kind === 'end') return {done: true, value: undefined}
            /* error */
            if (msg.cancelled) {
              return {
                done: false,
                value: err(
                  RequestError.Aborted(msg.message || String(options.signal?.reason ?? 'aborted')),
                ),
              }
            }
            return {
              done: false,
              value: err(RequestError.Network(msg.message || 'HTTP request failed')),
            }
          },
          async return() {
            if (!done) {
              done = true
              cleanup()
              native.cancel(id)
              try {
                for (;;) {
                  const msg = await native.nextMessage(id)
                  if (msg.kind !== 'chunk') break
                }
              } catch {
                /* ignore */
              }
            }
            return {done: true, value: undefined}
          },
        }
      },
    }

    return ok(
      makeResponse({
        status,
        statusText: '',
        url,
        redirected: false,
        headers: responseHeaders,
        body: rawBody,
      }),
    )
  }
}
