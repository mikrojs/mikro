/* Operators for `Observable.pipe(...)`, declared here and implemented in C
 * (mik_observable.cpp, module `mikro/observable/operators`). Each is a
 * factory returning a function `(source) => Observable`. Composition is pure
 * pipe: no method chaining on Observable itself.
 *
 * M0 scope: operators apply to non-fallible streams (`Err = never`). For
 * fallible streams (`Observable<Ok, Err>` with Err != never), corresponding
 * Result-aware operators (`mapOk`, `filterOk`, ...) ship when a concrete
 * consumer asks. Today no module produces fallible event streams.
 *
 * Errors: a throw inside a transform or a finalize callback propagates to the
 * dispatch boundary, which reports it and panics. Operators do not catch:
 * an application crash is an application crash.
 *
 * See `.claude/plans/observable.md` for the full design.
 */

import type {Observable} from './types.js'

type Op<A, B> = (source: Observable<A>) => Observable<B>

/* Map values through a transform. A throw inside `fn` panics. */
export declare function map<A, B>(fn: (value: A) => B): Op<A, B>

/* Pass through values matching `predicate`; a type guard narrows the output.
 * A throw inside it panics. */
export declare function filter<A, B extends A>(predicate: (value: A) => value is B): Op<A, B>
export declare function filter<A>(predicate: (value: A) => boolean): Op<A, A>

/* Run `fn` on each value, then pass it through unchanged. A throw inside
 * `fn` panics. */
export declare function tap<A>(fn: (value: A) => void): Op<A, A>

/* Take at most `count` values, then complete. count <= 0 completes immediately. */
export declare function take(count: number): <A>(source: Observable<A>) => Observable<A>

/* Drop the first `count` values, then pass the rest through. */
export declare function skip(count: number): <A>(source: Observable<A>) => Observable<A>

/* Fold values into an accumulator, emitting each intermediate result. */
export declare function scan<A, B>(fn: (acc: B, value: A) => B, seed: B): Op<A, B>

/* Drop values equal (by ===, or `equals`) to the previous one. */
export declare function distinctUntilChanged<A>(equals?: (a: A, b: A) => boolean): Op<A, A>

/* Emit `value` on subscribe, then pass the source through. */
export declare function startWith<A>(value: A): Op<A, A>

/* Run `fn` when the subscription ends for any reason (unsubscribe or
 * natural completion). A throw inside `fn` panics; the remaining teardowns
 * still run. */
export declare function finalize(fn: () => void): <A>(source: Observable<A>) => Observable<A>

/* Stop when `until` fires. An Observable ends the stream when it emits a
 * value (completing alone does not); a predicate ends it at the first value
 * it accepts, delivered too unless `inclusive` is false. */
export declare function takeUntil(
  notifier: Observable<unknown, unknown>,
): <A>(source: Observable<A>) => Observable<A>
export declare function takeUntil<A>(
  predicate: (value: A) => boolean,
  options?: {inclusive?: boolean},
): Op<A, A>

/* Interleave the source with `others`; completes when all of them have. */
export declare function mergeWith<A, B>(...others: Array<Observable<B>>): Op<A, A | B>

/* Pair each source value with the latest value of `other`. Source values
 * arriving before `other` has emitted are dropped. */
export declare function withLatestFrom<A, B>(other: Observable<B>): Op<A, [A, B]>

/* Emit the latest values of all sources whenever any of them emits, once
 * every source has emitted. Completes when all sources have, or as soon as
 * one completes without a value (no tuple can ever form). */
export declare function combineLatest<T extends readonly unknown[]>(sources: {
  [K in keyof T]: Observable<T[K]>
}): Observable<T>

/* Compose operators left to right into one operator, for reuse across
 * streams or as a `state()` pipeline. */
export declare function pipe<A>(): Op<A, A>
export declare function pipe<A, B>(op1: Op<A, B>): Op<A, B>
export declare function pipe<A, B, C>(op1: Op<A, B>, op2: Op<B, C>): Op<A, C>
export declare function pipe<A, B, C, D>(op1: Op<A, B>, op2: Op<B, C>, op3: Op<C, D>): Op<A, D>
export declare function pipe<A, B, C, D, E>(
  op1: Op<A, B>,
  op2: Op<B, C>,
  op3: Op<C, D>,
  op4: Op<D, E>,
): Op<A, E>
export declare function pipe<A, B, C, D, E, F>(
  op1: Op<A, B>,
  op2: Op<B, C>,
  op3: Op<C, D>,
  op4: Op<D, E>,
  op5: Op<E, F>,
): Op<A, F>
export declare function pipe<A, B, C, D, E, F, G>(
  op1: Op<A, B>,
  op2: Op<B, C>,
  op3: Op<C, D>,
  op4: Op<D, E>,
  op5: Op<E, F>,
  op6: Op<F, G>,
): Op<A, G>
export declare function pipe<A, B, C, D, E, F, G, H>(
  op1: Op<A, B>,
  op2: Op<B, C>,
  op3: Op<C, D>,
  op4: Op<D, E>,
  op5: Op<E, F>,
  op6: Op<F, G>,
  op7: Op<G, H>,
): Op<A, H>
export declare function pipe<A, B, C, D, E, F, G, H, I>(
  op1: Op<A, B>,
  op2: Op<B, C>,
  op3: Op<C, D>,
  op4: Op<D, E>,
  op5: Op<E, F>,
  op6: Op<F, G>,
  op7: Op<G, H>,
  op8: Op<H, I>,
): Op<A, I>
export declare function pipe<A, B, C, D, E, F, G, H, I, J>(
  op1: Op<A, B>,
  op2: Op<B, C>,
  op3: Op<C, D>,
  op4: Op<D, E>,
  op5: Op<E, F>,
  op6: Op<F, G>,
  op7: Op<G, H>,
  op8: Op<H, I>,
  op9: Op<I, J>,
): Op<A, J>
/* Longer chains still compose; type them by hand from the result. */
export declare function pipe<A, B, C, D, E, F, G, H, I, J>(
  op1: Op<A, B>,
  op2: Op<B, C>,
  op3: Op<C, D>,
  op4: Op<D, E>,
  op5: Op<E, F>,
  op6: Op<F, G>,
  op7: Op<G, H>,
  op8: Op<H, I>,
  op9: Op<I, J>,
  ...ops: Array<Op<any, any>>
): Op<A, unknown>

/* Map each value to an inner stream and pass on the latest inner stream's
 * values; a new value unsubscribes the previous inner stream. Completes once
 * the source and the last inner stream have both completed. */
export declare function switchMap<A, B>(project: (value: A) => Observable<B>): Op<A, B>

/* Emit 0 after `delayMs`, then complete; with `periodMs`, keep counting up
 * every period instead. */
export declare function timer(delayMs: number, periodMs?: number): Observable<number>

/* Which edge of a burst an operator emits on. */
export type EdgeOptions = {leading?: boolean; trailing?: boolean}

/* Emit a value only once `ms` have passed without another one. `trailing`
 * (default) emits the last value of a burst when it ends; `leading` emits the
 * first one at once. A pending trailing value is flushed on complete. */
export declare function debounceTime(
  ms: number,
  options?: EdgeOptions,
): <A>(source: Observable<A>) => Observable<A>

/* Emit one value per `ms` window and drop the rest. `leading` (default)
 * emits the value that opens a window; `trailing` emits the last dropped one
 * when the window ends, which opens the next window. A pending trailing
 * value is flushed on complete. */
export declare function throttleTime(
  ms: number,
  options?: EdgeOptions,
): <A>(source: Observable<A>) => Observable<A>
