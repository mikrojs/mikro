/**
 * Byte-level protocol reader for mikrojs.
 *
 * Separate runtime module from `mikrojs/stream` so that apps which
 * only need a buffered reader (a modem driver, a log framer, an HTTP
 * body splitter) don't pay the load cost of the async-iterator
 * transforms in `mikrojs/stream`. Both modules share the same
 * single-consumer design philosophy; they're separated only for
 * lazy-load efficiency.
 */

/**
 * A buffered byte reader over an async iterator of byte chunks.
 *
 * Wraps any `AsyncIterable<Uint8Array>` (typically `uart.read()`,
 * eventually also TCP sockets) and exposes three primitives that
 * share the same underlying byte buffer:
 *
 *   - `readUntil(delimiter, {timeoutMs})` — pull chunks until the
 *     buffer contains `delimiter`, return everything before it and
 *     consume the delimiter. The AT-channel workhorse: passes
 *     `CRLF` to read a line, or `'> '` to wait for a prompt.
 *
 *   - `readBytes(count, {timeoutMs})` — pull chunks until the buffer
 *     has at least `count` bytes, return the first `count` and keep
 *     the rest. Used for length-prefixed binary payloads (e.g.
 *     HTTP response bodies after `+SHREAD`).
 *
 *   - `drain()` — discard any buffered bytes without touching the
 *     underlying iterator. Useful before sending a new command when
 *     stale bytes from a previous response might be left over.
 *
 * Both `readUntil` and `readBytes` throw `TimeoutError` (an Error
 * with `name === 'TimeoutError'`) if the deadline expires before
 * the request is satisfied, and `StreamClosed` (an Error with
 * `name === 'StreamClosed'`) if the underlying iterator finishes
 * before the request is satisfied. Callers may wrap those in their
 * own Result type if they prefer structured error handling.
 *
 * Timeout semantics: when a pull races against a `setTimeout` and
 * the timer wins, the pending `iter.next()` promise is kept so the
 * NEXT pull resumes on the same chunk — bytes received during the
 * timed-out window are not dropped. This matches the behavior of
 * hand-written AT channels and is what you want for command retries.
 *
 * This reader is intentionally **single-consumer**. Interleaving
 * concurrent `readUntil` / `readBytes` calls is not supported and
 * not protected against — the caller is responsible for
 * sequential ordering.
 */
export class BufferedReader {
  readonly #source: AsyncIterator<Uint8Array>
  #buffer: Uint8Array
  #pending: Promise<IteratorResult<Uint8Array>> | null

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#source = source[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>
    this.#buffer = new Uint8Array(0)
    this.#pending = null
  }

  async readUntil(delimiter: Uint8Array, options: {timeoutMs: number}): Promise<Uint8Array> {
    if (delimiter.length === 0) {
      throw new RangeError('BufferedReader.readUntil: delimiter must be non-empty')
    }
    const deadline = Date.now() + options.timeoutMs
    while (true) {
      const idx = indexOfBytes(this.#buffer, delimiter)
      if (idx !== -1) {
        const out = this.#buffer.slice(0, idx)
        this.#buffer = this.#buffer.slice(idx + delimiter.length)
        return out
      }
      await this.#pull(deadline)
    }
  }

  async readBytes(count: number, options: {timeoutMs: number}): Promise<Uint8Array> {
    if (count < 0) {
      throw new RangeError('BufferedReader.readBytes: count must be non-negative')
    }
    if (count === 0) return new Uint8Array(0)
    const deadline = Date.now() + options.timeoutMs
    while (this.#buffer.length < count) {
      await this.#pull(deadline)
    }
    const out = this.#buffer.slice(0, count)
    this.#buffer = this.#buffer.slice(count)
    return out
  }

  /**
   * Discard buffered bytes. Leaves `#pending` alone so any in-flight
   * `iter.next()` from a previously timed-out pull still gets
   * consumed on the next read — we only want to drop stale bytes
   * that were already delivered, not bytes the source hasn't sent
   * yet.
   */
  drain(): void {
    this.#buffer = new Uint8Array(0)
  }

  async #pull(deadline: number): Promise<void> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      const err = new Error(`BufferedReader: timeout waiting for bytes`)
      err.name = 'TimeoutError'
      throw err
    }

    if (this.#pending === null) {
      this.#pending = this.#source.next()
    }
    const pending = this.#pending

    let timerId: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        pending.then((v): {kind: 'value'; v: IteratorResult<Uint8Array>} => ({kind: 'value', v})),
        new Promise<{kind: 'timeout'}>((resolve) => {
          timerId = setTimeout(() => resolve({kind: 'timeout'}), remaining)
        }),
      ])
      if (result.kind === 'timeout') {
        // Leave #pending intact so the next pull resumes on this chunk.
        const err = new Error(`BufferedReader: timeout after ${remaining}ms waiting for bytes`)
        err.name = 'TimeoutError'
        throw err
      }
      this.#pending = null
      if (result.v.done) {
        const err = new Error('BufferedReader: stream closed before read satisfied')
        err.name = 'StreamClosed'
        throw err
      }
      this.#buffer = concatBytes(this.#buffer, result.v.value)
    } finally {
      if (timerId !== undefined) clearTimeout(timerId)
    }
  }
}

/** Find the first index of `needle` in `haystack`, or -1 if not found. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0
  const limit = haystack.length - needle.length
  for (let i = 0; i <= limit; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
