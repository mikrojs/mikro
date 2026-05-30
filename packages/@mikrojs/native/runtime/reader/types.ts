/**
 * Public types for `mikrojs/reader`.
 *
 * Runtime implementation lives in `./reader.ts` and is compiled to
 * bytecode at firmware build time. This file is the declaration-only
 * surface consumed by the `mikrojs/reader` re-export in
 * `packages/mikrojs` and by user apps via their tsconfig.
 */

import type {Result} from 'mikro/result'

export type ReaderError = {name: 'Timeout'; ms: number} | {name: 'StreamClosed'}

/**
 * A buffered byte reader over a Result-yielding async iterator of
 * `Uint8Array` chunks. Offers three operations that share the same
 * underlying buffer:
 *
 *   - `readUntil(delimiter, {timeoutMs})` — return everything before
 *     the first occurrence of `delimiter`, consume the delimiter.
 *   - `readBytes(count, {timeoutMs})` — return exactly `count` bytes,
 *     pulling more source chunks as needed.
 *   - `drain()` — discard buffered bytes without affecting the
 *     underlying iterator.
 *
 * Returns `err({name: 'Timeout', ms})` if the deadline expires,
 * `err({name: 'StreamClosed'})` if the underlying iterator finishes
 * early, or the source's own error variant when it yields one.
 * `RangeError` is still thrown for invalid arguments.
 *
 * Single-consumer only: concurrent `readUntil` / `readBytes` calls on
 * the same instance are unsupported.
 */
export declare class BufferedReader<E = never> {
  constructor(source: AsyncIterable<Result<Uint8Array, E>>)
  readUntil(
    delimiter: Uint8Array,
    options: {timeoutMs: number},
  ): Promise<Result<Uint8Array, E | ReaderError>>
  readBytes(
    count: number,
    options: {timeoutMs: number},
  ): Promise<Result<Uint8Array, E | ReaderError>>
  drain(): void
}
