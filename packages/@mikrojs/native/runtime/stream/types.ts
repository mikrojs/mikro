/**
 * Public types for `mikrojs/stream`.
 *
 * The runtime implementation lives in `./stream.ts` and is compiled to
 * bytecode at firmware build time. This file is the declaration-only
 * surface consumed by the `mikrojs/stream` re-export in
 * `packages/mikrojs` and by user apps via their tsconfig.
 */

/** Decode a stream of UTF-8 byte chunks into a stream of strings. */
export declare function decodeUtf8(source: AsyncIterable<Uint8Array>): AsyncIterable<string>

/**
 * Split a stream of text into a stream of lines on the given delimiter
 * (default `\n`). Partial lines spanning chunk boundaries are buffered
 * and reassembled. Empty lines between consecutive delimiters are
 * preserved. Throws `RangeError` if called with an empty delimiter.
 */
export declare function splitLines(
  source: AsyncIterable<string>,
  delimiter?: string,
): AsyncIterable<string>

/**
 * Consume a stream until an item matches `predicate`, then stop.
 *
 * Returns `{matched, collected}` where `collected` is every item that
 * came BEFORE the match (not including the matching item). Throws an
 * Error with `name === 'StreamClosed'` if the stream ends before any
 * item matches.
 */
export declare function collectUntil<T>(
  source: AsyncIterable<T>,
  predicate: (item: T) => boolean,
): Promise<{matched: T; collected: T[]}>

/**
 * Wrap an async iterable with a total-duration deadline. Throws an
 * Error with `name === 'TimeoutError'` if the next item doesn't
 * arrive in time. Releases the upstream iterator via `return()` on
 * timeout, error, or consumer break.
 */
export declare function withTimeout<T>(source: AsyncIterable<T>, ms: number): AsyncIterable<T>

/* BufferedReader lives in the sibling `mikrojs/reader` module — see
 * `runtime/reader/` — so apps that only need byte-level framing can
 * avoid loading the async-generator transforms above. */
