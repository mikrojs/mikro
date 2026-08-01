/* Operators for `Observable.pipe(...)`. Each is a factory returning a
 * function `(source) => Observable`. Composition is pure pipe — no method
 * chaining on Observable itself.
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

import {Observable as NativeObservable} from 'native:mikro/observable'

import type {Observable as ObservableT} from './types.js'

/* `native:mikro/observable` resolves only inside the runtime build; outside
 * (twoslash, host typecheck without internal.d.ts) it falls back to `any`,
 * which collapses pipe/operator inference at use sites. Pin the type to the
 * declared class in `./types.ts` so consumers always see the typed shape. */
const Observable = NativeObservable as unknown as typeof ObservableT
type Observable<Ok, Err = never> = ObservableT<Ok, Err>

/* Map values through a transform. A throw inside `fn` panics. */
export const map =
  <A, B>(fn: (value: A) => B) =>
  (source: Observable<A>): Observable<B> =>
    new Observable<B>((sub) => {
      const upstream = source.subscribe({
        next: (value) => sub.next(fn(value)),
        complete: () => sub.complete(),
      })
      sub.addTeardown(() => upstream.unsubscribe())
    })

/* Pass through values matching `predicate`. A throw inside it panics. */
export const filter =
  <A>(predicate: (value: A) => boolean) =>
  (source: Observable<A>): Observable<A> =>
    new Observable<A>((sub) => {
      const upstream = source.subscribe({
        next: (value) => {
          if (predicate(value)) sub.next(value)
        },
        complete: () => sub.complete(),
      })
      sub.addTeardown(() => upstream.unsubscribe())
    })

/* Take at most `count` values, then complete. count <= 0 completes immediately. */
export const take =
  (count: number) =>
  <A>(source: Observable<A>): Observable<A> =>
    new Observable<A>((sub) => {
      if (count <= 0) {
        sub.complete()
        return
      }
      let remaining = count
      const upstream = source.subscribe({
        next: (value) => {
          if (remaining <= 0) return
          remaining--
          sub.next(value)
          if (remaining === 0) sub.complete()
        },
        complete: () => sub.complete(),
      })
      sub.addTeardown(() => upstream.unsubscribe())
    })

/* Stop emitting when `notifier` emits its first value. Notifier completing
 * without emitting is NOT a trigger — primary keeps going. */
export const takeUntil =
  (notifier: Observable<unknown, unknown>) =>
  <A>(source: Observable<A>): Observable<A> =>
    new Observable<A>((sub) => {
      const upstream = source.subscribe({
        next: (value) => sub.next(value),
        complete: () => sub.complete(),
      })
      const notifierSub = notifier.subscribe({
        next: () => sub.complete(),
      })
      sub.addTeardown(() => {
        notifierSub.unsubscribe()
        upstream.unsubscribe()
      })
    })

/* Run `fn` when the subscription ends for any reason (unsubscribe or
 * natural completion). A throw inside `fn` panics; the remaining teardowns
 * still run. RxJS naming. */
export const finalize =
  (fn: () => void) =>
  <A>(source: Observable<A>): Observable<A> =>
    new Observable<A>((sub) => {
      const upstream = source.subscribe({
        next: (value) => sub.next(value),
        complete: () => sub.complete(),
      })
      sub.addTeardown(() => {
        upstream.unsubscribe()
        fn()
      })
    })
