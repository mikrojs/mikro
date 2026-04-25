/**
 * Minimal composable stream primitives for mikrojs.
 *
 * Streams are plain `AsyncIterable<T>` — no class hierarchy, no
 * lockable readers, no BYOB, no queueing strategies. Transforms are
 * async generator functions. Composition is function call.
 *
 * This is deliberately a subset of what Snell's "new-streams" proposal
 * covers, adapted for the realities of QuickJS on a microcontroller:
 * no fast-path promise optimizations, no sendfile-style native
 * shortcuts, tight heap budget.
 *
 * V1 scope: enough to rewrite a modem AT channel as a one-file shim.
 * Expand only when a second call site asks for it.
 */

/** Decode a stream of UTF-8 byte chunks into a stream of strings. */
export async function* decodeUtf8(source: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  for await (const chunk of source) yield decoder.decode(chunk, {stream: true})
  yield decoder.decode()
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
export async function* splitLines(
  source: AsyncIterable<string>,
  delimiter: string = '\n',
): AsyncIterable<string> {
  // indexOf('') returns 0 unconditionally, which would make the inner
  // loop spin forever yielding empty strings. Reject at entry instead
  // of hanging the event loop on a user mistake.
  if (delimiter.length === 0) {
    throw new RangeError('splitLines: delimiter must be non-empty')
  }
  let buffer = ''
  for await (const chunk of source) {
    buffer += chunk
    let idx = buffer.indexOf(delimiter)
    while (idx !== -1) {
      yield buffer.slice(0, idx)
      buffer = buffer.slice(idx + delimiter.length)
      idx = buffer.indexOf(delimiter)
    }
  }
  if (buffer.length > 0) yield buffer
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
 * If the stream closes before any item matches, throws `StreamClosed`
 * (a plain Error with a `.name`). Callers should wrap this in their
 * own Result type if they want structured error handling.
 */
export async function collectUntil<T>(
  source: AsyncIterable<T>,
  predicate: (item: T) => boolean,
): Promise<{matched: T; collected: T[]}> {
  const collected: T[] = []
  for await (const item of source) {
    if (predicate(item)) {
      return {matched: item, collected}
    }
    collected.push(item)
  }
  const err = new Error('Stream closed before predicate matched')
  err.name = 'StreamClosed'
  throw err
}

/**
 * Wrap an async iterable with a total-duration timeout.
 *
 * The deadline starts when this function is called (not per-item).
 * If the next item doesn't arrive before the deadline, the returned
 * iterable throws a `TimeoutError`, and cleans up the upstream source
 * by calling its `return()` method. Callers using `for await` will see
 * the error propagate out of the loop.
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
export async function* withTimeout<T>(source: AsyncIterable<T>, ms: number): AsyncIterable<T> {
  const deadline = Date.now() + ms
  const iter = source[Symbol.asyncIterator]()
  try {
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        const err = new Error(`Stream did not complete within ${ms}ms`)
        err.name = 'TimeoutError'
        throw err
      }

      let timerId: ReturnType<typeof setTimeout> | undefined
      let result: IteratorResult<T, unknown>
      try {
        result = await Promise.race([
          iter.next(),
          new Promise<IteratorResult<T, unknown>>((_, reject) => {
            timerId = setTimeout(() => {
              const err = new Error(`Stream did not complete within ${ms}ms`)
              err.name = 'TimeoutError'
              reject(err)
            }, remaining)
          }),
        ])
      } finally {
        if (timerId !== undefined) clearTimeout(timerId)
      }

      if (result.done) return
      yield result.value as T
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
