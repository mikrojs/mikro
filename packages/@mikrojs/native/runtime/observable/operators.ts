/* eslint-disable no-console */
/* console.error inside operator dispatch is intentional: it matches the
 * existing mik_call_handler precedent in the C layer (log + continue rather
 * than panic). See .claude/plans/observable.md → Errors section. */

/* Operators for `Observable.pipe(...)`. Each is a factory returning a
 * function `(source) => Observable`. Composition is pure pipe — no method
 * chaining on Observable itself.
 *
 * M0 scope: operators apply to non-fallible streams (`Err = never`). For
 * fallible streams (`Observable<Ok, Err>` with Err != never), corresponding
 * Result-aware operators (`mapOk`, `filterOk`, ...) ship when a concrete
 * consumer asks. Today no module produces fallible event streams.
 *
 * See `.claude/plans/observable.md` for the full design.
 */

/* Importing from `mikrojs/observable` (not `native:observable`) so this
 * module typechecks from any package that already re-exports it. At runtime
 * `mikrojs/observable` resolves to the bytecode bundle which re-exports the
 * native class; at typecheck it resolves to the ambient `declare class` in
 * runtime/observable/types.ts. */
import {Observable} from 'mikrojs/observable'

/* Map values through a transform. Throws inside `fn` are caught at the
 * dispatch boundary; the bad value is dropped for that subscription, others
 * are unaffected. */
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
            console.error(err)
            return
          }
          sub.next(next)
        },
        complete: () => sub.complete(),
      })
      sub.addTeardown(() => upstream.unsubscribe())
    })

/* Pass through values matching `pred`. `pred` errors are caught + logged. */
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
            console.error(err)
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
 * natural completion). Throws inside `fn` are caught + logged so other
 * teardowns still run. RxJS naming. */
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
          console.error(err)
        }
      })
    })
