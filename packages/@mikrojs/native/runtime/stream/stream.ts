/**
 * Minimal composable stream primitives for mikrojs.
 *
 * Streams are `AsyncIterable<Result<T, E>>` — Result-yielding rather
 * than throwing — so error handling composes uniformly with the rest
 * of the runtime's Result-based APIs. Combinators short-circuit on the
 * first err item: they yield the err and return.
 *
 * Combinators that originate their own errors (`withTimeout`,
 * `collectUntil`) widen the result's error type with a `StreamError`
 * variant defined in `./types.ts`.
 *
 * V1 scope: enough to rewrite a modem AT channel as a one-file shim.
 * Expand only when a second call site asks for it.
 */

import {err, ok} from 'mikrojs/result'

import type {Result} from '../result/types.js'

/** Decode a stream of UTF-8 byte chunks into a stream of strings. */
export async function* decodeUtf8<E>(
  source: AsyncIterable<Result<Uint8Array, E>>,
): AsyncIterable<Result<string, E>> {
  const decoder = new TextDecoder()
  for await (const r of source) {
    if (!r.ok) {
      yield r
      return
    }
    yield ok(decoder.decode(r.value, {stream: true}))
  }
  const final = decoder.decode()
  if (final.length > 0) yield ok(final)
}

/**
 * Split a stream of text into a stream of lines.
 *
 * The delimiter is a string (default `\n`). Partial lines that don't
 * end with the delimiter in a given input chunk are held in an
 * internal buffer and prepended to the next chunk's content — so
 * splitting happens correctly regardless of how the underlying source
 * chunks its data. If the source closes before emitting a final
 * delimiter, any trailing buffered content is emitted as a final line
 * (matching how Node's readline handles EOF).
 *
 * Empty lines (consecutive delimiters) are preserved. This matters
 * for protocols that use a blank line as a separator, e.g. HTTP
 * headers vs. body.
 */
export async function* splitLines<E>(
  source: AsyncIterable<Result<string, E>>,
  delimiter: string = '\n',
): AsyncIterable<Result<string, E>> {
  // indexOf('') returns 0 unconditionally, which would make the inner
  // loop spin forever yielding empty strings. Reject at entry instead
  // of hanging the event loop on a user mistake.
  if (delimiter.length === 0) {
    throw new RangeError('splitLines: delimiter must be non-empty')
  }
  let buffer = ''
  for await (const r of source) {
    if (!r.ok) {
      yield r
      return
    }
    buffer += r.value
    let idx = buffer.indexOf(delimiter)
    while (idx !== -1) {
      yield ok(buffer.slice(0, idx))
      buffer = buffer.slice(idx + delimiter.length)
      idx = buffer.indexOf(delimiter)
    }
  }
  if (buffer.length > 0) yield ok(buffer)
}

/**
 * Consume a stream until an item matches `predicate`, then stop.
 *
 * Returns both the matching item and every item that came before it.
 * The matching item is NOT included in `collected` — callers who need
 * it have `matched` for that. This distinction matters for protocols
 * like modem AT commands where the terminator (`OK`/`ERROR`) is
 * semantically different from the response body lines in between.
 *
 * If the stream closes before any item matches, returns
 * `err({name: 'StreamClosed'})`. Source errors propagate unchanged.
 */
export async function collectUntil<T, E>(
  source: AsyncIterable<Result<T, E>>,
  predicate: (item: T) => boolean,
): Promise<Result<{matched: T; collected: T[]}, E | {name: 'StreamClosed'}>> {
  const collected: T[] = []
  for await (const r of source) {
    if (!r.ok) return r
    if (predicate(r.value)) return ok({matched: r.value, collected})
    collected.push(r.value)
  }
  return err({name: 'StreamClosed' as const})
}

/**
 * Wrap an async iterable with a total-duration timeout.
 *
 * The deadline starts when this function is called (not per-item).
 * If the next item doesn't arrive before the deadline, yields
 * `err({name: 'Timeout', ms})` and ends, cleaning up the upstream
 * source by calling its `return()` method. Source errors propagate
 * unchanged.
 *
 * Implementation notes:
 * - Promise.race with setTimeout would leak orphaned timers on the
 *   fast path (source wins, setTimeout's callback still fires
 *   eventually). We track the timer id and clearTimeout() in a finally
 *   around the race so fast-path calls don't accumulate pending jobs.
 * - The upstream iterator is explicitly .return()'d on exit (normal,
 *   timeout, or consumer break) so underlying resources (UART claims,
 *   socket handles, ring buffers) get released.
 */
export async function* withTimeout<T, E>(
  source: AsyncIterable<Result<T, E>>,
  ms: number,
): AsyncIterable<Result<T, E | {name: 'Timeout'; ms: number}>> {
  const deadline = Date.now() + ms
  const iter = source[Symbol.asyncIterator]()
  try {
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        yield err({name: 'Timeout' as const, ms})
        return
      }

      let timerId: ReturnType<typeof setTimeout> | undefined
      let result: IteratorResult<Result<T, E>, unknown>
      let timedOut = false
      try {
        result = await Promise.race([
          iter.next(),
          new Promise<IteratorResult<Result<T, E>, unknown>>((resolve) => {
            timerId = setTimeout(() => {
              timedOut = true
              resolve({done: true, value: undefined})
            }, remaining)
          }),
        ])
      } finally {
        if (timerId !== undefined) clearTimeout(timerId)
      }

      if (timedOut) {
        yield err({name: 'Timeout' as const, ms})
        return
      }
      if (result.done) return
      yield result.value
      if (!result.value.ok) return
    }
  } finally {
    if (typeof iter.return === 'function') {
      try {
        await iter.return(undefined)
      } catch {
        /* swallow — upstream cleanup errors shouldn't mask ours */
      }
    }
  }
}
