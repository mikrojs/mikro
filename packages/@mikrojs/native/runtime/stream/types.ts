/**
 * Public types for `mikrojs/stream`.
 *
 * The runtime implementation lives in `./stream.ts` and is compiled to
 * bytecode at firmware build time. This file is the declaration-only
 * surface consumed by the `mikrojs/stream` re-export in
 * `packages/mikrojs` and by user apps via their tsconfig.
 *
 * Streaming sources yield `Result<T, E>` rather than throwing — see
 * the design note in `stream.ts`. Combinators that originate their own
 * errors widen the error type with a `StreamError` variant.
 */

import type {Result} from 'mikrojs/result'

export type StreamError = {name: 'Timeout'; ms: number} | {name: 'StreamClosed'}

/** Decode a stream of UTF-8 byte chunks into a stream of strings. */
export declare function decodeUtf8<E>(
  source: AsyncIterable<Result<Uint8Array, E>>,
): AsyncIterable<Result<string, E>>

/**
 * Split a stream of text into a stream of lines on the given delimiter
 * (default `\n`). Partial lines spanning chunk boundaries are buffered
 * and reassembled. Empty lines between consecutive delimiters are
 * preserved. Throws `RangeError` if called with an empty delimiter
 * (programmer error, not a stream error).
 */
export declare function splitLines<E>(
  source: AsyncIterable<Result<string, E>>,
  delimiter?: string,
): AsyncIterable<Result<string, E>>

/**
 * Consume a stream until an item matches `predicate`, then stop.
 *
 * Returns `ok({matched, collected})` where `collected` is every item
 * that came BEFORE the match (not including the matching item).
 * Returns `err({name: 'StreamClosed'})` if the stream ends before any
 * item matches. Propagates the source's error variants unchanged.
 */
export declare function collectUntil<T, E>(
  source: AsyncIterable<Result<T, E>>,
  predicate: (item: T) => boolean,
): Promise<Result<{matched: T; collected: T[]}, E | Extract<StreamError, {name: 'StreamClosed'}>>>

/**
 * Wrap an async iterable with a total-duration deadline. Yields
 * `err({name: 'Timeout', ms})` if the next item doesn't arrive in
 * time, then ends. Releases the upstream iterator via `return()` on
 * timeout, source error, or consumer break.
 */
export declare function withTimeout<T, E>(
  source: AsyncIterable<Result<T, E>>,
  ms: number,
): AsyncIterable<Result<T, E | Extract<StreamError, {name: 'Timeout'}>>>

/* BufferedReader lives in the sibling `mikrojs/reader` module — see
 * `runtime/reader/` — so apps that only need byte-level framing can
 * avoid loading the async-generator transforms above. */
