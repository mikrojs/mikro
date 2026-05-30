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

import {err, ok} from 'mikro/result'

import type {Result} from '../result/types.js'

export type ReaderError = {name: 'Timeout'; ms: number} | {name: 'StreamClosed'}

/**
 * A buffered byte reader over a Result-yielding async iterator of
 * byte chunks.
 *
 * Wraps any `AsyncIterable<Result<Uint8Array, E>>` (typically
 * `uart.read()`, `fs.readStream`, an HTTP body) and exposes three
 * primitives that share the same underlying byte buffer:
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
 * Both `readUntil` and `readBytes` return `Result<Uint8Array, E |
 * ReaderError>`: `err({name: 'Timeout', ms})` if the deadline expires
 * before the request is satisfied, `err({name: 'StreamClosed'})` if
 * the underlying iterator finishes early, or whatever error variant
 * the source yields. `RangeError` is still thrown for invalid
 * arguments (programmer mistakes, not stream errors).
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
export class BufferedReader<E = never> {
  readonly #source: AsyncIterator<Result<Uint8Array, E>>
  #buffer: Uint8Array
  #pending: Promise<IteratorResult<Result<Uint8Array, E>>> | null

  constructor(source: AsyncIterable<Result<Uint8Array, E>>) {
    this.#source = source[Symbol.asyncIterator]() as AsyncIterator<Result<Uint8Array, E>>
    this.#buffer = new Uint8Array(0)
    this.#pending = null
  }

  async readUntil(
    delimiter: Uint8Array,
    options: {timeoutMs: number},
  ): Promise<Result<Uint8Array, E | ReaderError>> {
    if (delimiter.length === 0) {
      throw new RangeError('BufferedReader.readUntil: delimiter must be non-empty')
    }
    const deadline = Date.now() + options.timeoutMs
    while (true) {
      const idx = indexOfBytes(this.#buffer, delimiter)
      if (idx !== -1) {
        const out = this.#buffer.slice(0, idx)
        this.#buffer = this.#buffer.slice(idx + delimiter.length)
        return ok(out)
      }
      const pull = await this.#pull(deadline, options.timeoutMs)
      if (!pull.ok) return pull
    }
  }

  async readBytes(
    count: number,
    options: {timeoutMs: number},
  ): Promise<Result<Uint8Array, E | ReaderError>> {
    if (count < 0) {
      throw new RangeError('BufferedReader.readBytes: count must be non-negative')
    }
    if (count === 0) return ok(new Uint8Array(0))
    const deadline = Date.now() + options.timeoutMs
    while (this.#buffer.length < count) {
      const pull = await this.#pull(deadline, options.timeoutMs)
      if (!pull.ok) return pull
    }
    const out = this.#buffer.slice(0, count)
    this.#buffer = this.#buffer.slice(count)
    return ok(out)
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

  async #pull(deadline: number, timeoutMs: number): Promise<Result<void, E | ReaderError>> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return err({name: 'Timeout' as const, ms: timeoutMs})

    if (this.#pending === null) {
      this.#pending = this.#source.next()
    }
    const pending = this.#pending

    let timerId: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        pending.then((v): {kind: 'value'; v: IteratorResult<Result<Uint8Array, E>>} => ({
          kind: 'value',
          v,
        })),
        new Promise<{kind: 'timeout'}>((resolve) => {
          timerId = setTimeout(() => resolve({kind: 'timeout'}), remaining)
        }),
      ])
      if (result.kind === 'timeout') {
        // Leave #pending intact so the next pull resumes on this chunk.
        return err({name: 'Timeout' as const, ms: timeoutMs})
      }
      this.#pending = null
      if (result.v.done) return err({name: 'StreamClosed' as const})
      const item = result.v.value
      if (!item.ok) return item
      this.#buffer = concatBytes(this.#buffer, item.value)
      return ok()
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
