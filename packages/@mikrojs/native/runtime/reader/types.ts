/**
 * Public types for `mikrojs/reader`.
 *
 * Runtime implementation lives in `./reader.ts` and is compiled to
 * bytecode at firmware build time. This file is the declaration-only
 * surface consumed by the `mikrojs/reader` re-export in
 * `packages/mikrojs` and by user apps via their tsconfig.
 */

/**
 * A buffered byte reader over an async iterator of `Uint8Array`
 * chunks. Offers three operations that share the same underlying
 * buffer:
 *
 *   - `readUntil(delimiter, {timeoutMs})` — return everything before
 *     the first occurrence of `delimiter`, consume the delimiter.
 *   - `readBytes(count, {timeoutMs})` — return exactly `count` bytes,
 *     pulling more source chunks as needed.
 *   - `drain()` — discard buffered bytes without affecting the
 *     underlying iterator.
 *
 * Throws an Error with `name === 'TimeoutError'` if the deadline
 * expires before the request is satisfied, or `name === 'StreamClosed'`
 * if the underlying iterator finishes before the request is satisfied.
 *
 * Single-consumer only: concurrent `readUntil` / `readBytes` calls on
 * the same instance are unsupported.
 */
export declare class BufferedReader {
  constructor(source: AsyncIterable<Uint8Array>)
  readUntil(delimiter: Uint8Array, options: {timeoutMs: number}): Promise<Uint8Array>
  readBytes(count: number, options: {timeoutMs: number}): Promise<Uint8Array>
  drain(): void
}
