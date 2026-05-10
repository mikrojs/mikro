/* Operators for `Observable.pipe(...)`. Each is a factory returning a
 * function `(source) => Observable`. Composition is pure pipe — no method
 * chaining on Observable itself.
 *
 * M0 scope: operators apply to non-fallible streams (`Err = never`). For
 * fallible streams (`Observable<Ok, Err>` with Err != never), corresponding
 * Result-aware operators (`mapOk`, `filterOk`, ...) ship when a concrete
 * consumer asks. Today no module produces fallible event streams.
 *
 * Errors: throws inside operator transforms or finalize callbacks are caught
 * at the dispatch boundary, isolated to that subscriber, and re-thrown
 * asynchronously via setTimeout(0). The synchronous producer keeps going
 * (the bad value is dropped, sibling subscribers untouched), and on device
 * the eventual uncaught throw halts the runtime via the existing
 * unhandled-rejection path. Stream errors are panics.
 *
 * See `.claude/plans/observable.md` for the full design.
 */

import {Observable as NativeObservable} from 'native:observable'

import type {Observable as ObservableT} from './types.js'

/* `native:observable` resolves only inside the runtime build; outside
 * (twoslash, host typecheck without internal.d.ts) it falls back to `any`,
 * which collapses pipe/operator inference at use sites. Pin the type to the
 * declared class in `./types.ts` so consumers always see the typed shape. */
const Observable = NativeObservable as unknown as typeof ObservableT
type Observable<Ok, Err = never> = ObservableT<Ok, Err>

/* Catch a thrown error and re-throw it on the next tick. The synchronous
 * caller keeps going; the error eventually surfaces as an uncaught
 * exception. */
function panicAsync(err: unknown): void {
  setTimeout(() => {
    throw err
  }, 0)
}

/* Map values through a transform. Throws inside `fn` are caught and
 * scheduled to re-throw on the next tick (panic). The bad value is dropped
 * for that subscription; sibling subscriptions are unaffected. */
export const map =
  <A, B>(fn: (value: A) => B) =>
  (source: Observable<A>): Observable<B> =>
    new Observable<B>((sub) => {
      const upstream = source.subscribe({
        next: (value) => {
          let next: B
          try {
            next = fn(value)
          } catch (err) {
            panicAsync(err)
            return
          }
          sub.next(next)
        },
        complete: () => sub.complete(),
      })
      sub.addTeardown(() => upstream.unsubscribe())
    })

/* Pass through values matching `pred`. `pred` errors panic asynchronously. */
export const filter =
  <A>(pred: (value: A) => boolean) =>
  (source: Observable<A>): Observable<A> =>
    new Observable<A>((sub) => {
      const upstream = source.subscribe({
        next: (value) => {
          let keep: boolean
          try {
            keep = pred(value)
          } catch (err) {
            panicAsync(err)
            return
          }
          if (keep) sub.next(value)
        },
        complete: () => sub.complete(),
      })
      sub.addTeardown(() => upstream.unsubscribe())
    })

/* Take at most n values, then complete. n <= 0 completes immediately. */
export const take =
  (n: number) =>
  <A>(source: Observable<A>): Observable<A> =>
    new Observable<A>((sub) => {
      if (n <= 0) {
        sub.complete()
        return
      }
      let remaining = n
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
 * natural completion). Throws inside `fn` are caught and panic
 * asynchronously, so subsequent teardowns still run. RxJS naming. */
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
        try {
          fn()
        } catch (err) {
          panicAsync(err)
        }
      })
    })
