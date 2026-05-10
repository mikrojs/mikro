// Host-side shim for `native:observable`, used only in vitest (Node) where
// the mikrojs C runtime isn't available. Keep in sync with mik_observable.cpp.
//
// Mirrors the locked design in .claude/plans/observable.md:
// - subscribe() returns a Subscription with unsubscribe() (no AbortSignal)
// - no error channel — throws inside dispatch or teardown are caught at the
//   boundary, isolated to the offending subscriber, and re-thrown
//   asynchronously via setTimeout(0) so the synchronous producer keeps
//   running but the bug eventually surfaces (and on device, halts the
//   runtime via the existing unhandled-rejection path)
// - sync emission allowed
// - pipe-only composition (operators live in operators.ts)
// - withEmitters() factory: {observable, next, complete}

/* Catch a thrown error and re-throw it on the next tick. The synchronous
 * caller keeps going (other subscribers receive the value, remaining
 * teardowns run); the error eventually surfaces as an uncaught exception. */
function panicAsync(err: unknown): void {
  setTimeout(() => {
    throw err
  }, 0)
}

class Subscriber<T> {
  closed = false
  private next_fn: ((v: T) => void) | undefined
  private complete_fn: (() => void) | undefined
  private teardowns: Array<() => void> = []

  constructor(observer: unknown) {
    if (observer == null) return
    if (typeof observer === 'function') {
      this.next_fn = observer as (v: T) => void
    } else if (typeof observer === 'object') {
      const o = observer as {next?: (v: T) => void; complete?: () => void}
      if (typeof o.next === 'function') this.next_fn = o.next
      if (typeof o.complete === 'function') this.complete_fn = o.complete
    } else {
      throw new TypeError('subscribe: observer must be a function, object, undefined, or null')
    }
  }

  next(value: T): void {
    if (this.closed) return
    if (this.next_fn) {
      try {
        this.next_fn(value)
      } catch (err) {
        panicAsync(err)
      }
    }
  }

  complete(): void {
    if (this.closed) return
    this.closed = true
    if (this.complete_fn) {
      try {
        this.complete_fn()
      } catch (err) {
        panicAsync(err)
      }
    }
    this.runTeardowns()
  }

  addTeardown(fn: () => void): void {
    if (typeof fn !== 'function') {
      throw new TypeError('addTeardown: argument must be a function')
    }
    if (this.closed) {
      try {
        fn()
      } catch (err) {
        panicAsync(err)
      }
      return
    }
    this.teardowns.push(fn)
  }

  // Used by Subscription.unsubscribe — silent (no observer.complete call).
  closeSilently(): void {
    if (this.closed) return
    this.closed = true
    this.runTeardowns()
  }

  private runTeardowns(): void {
    const list = this.teardowns
    this.teardowns = []
    for (let i = list.length - 1; i >= 0; i--) {
      try {
        list[i]!()
      } catch (err) {
        panicAsync(err)
      }
    }
  }
}

class Subscription {
  constructor(private subscriber: Subscriber<unknown>) {}
  unsubscribe(): void {
    this.subscriber.closeSilently()
  }
}

type SubscribeCallback<T> = (sub: Subscriber<T>) => void

export class Observable<Ok, Err = never> {
  // The shim doesn't actually use `_phantom` at runtime; the type parameters are
  // purely for type-level alignment with the public interface.
  declare readonly _phantom: [Ok, Err]
  #cb: SubscribeCallback<unknown>

  constructor(cb: SubscribeCallback<unknown>) {
    if (typeof cb !== 'function') {
      throw new TypeError('Observable: constructor requires a function argument')
    }
    this.#cb = cb
  }

  subscribe(observer?: unknown): Subscription {
    const sub = new Subscriber<unknown>(observer)
    try {
      this.#cb(sub)
    } catch (err) {
      sub.closeSilently()
      throw err
    }
    return new Subscription(sub)
  }

  pipe(...ops: Array<(o: Observable<unknown, unknown>) => Observable<unknown, unknown>>) {
    let current: Observable<unknown, unknown> = this as unknown as Observable<unknown, unknown>
    for (const op of ops) {
      if (typeof op !== 'function') {
        throw new TypeError('pipe: arguments must be operator functions')
      }
      current = op(current)
    }
    return current
  }

  static from(src: unknown): Observable<unknown, unknown> {
    if (src instanceof Observable) return src
    if (
      src != null &&
      (typeof src === 'object' || typeof src === 'function') &&
      typeof (src as {then?: unknown}).then === 'function'
    ) {
      // Promise-shaped
      return new Observable<unknown>((sub) => {
        ;(src as PromiseLike<unknown>).then((value) => {
          if (sub.closed) return
          sub.next(value)
          if (sub.closed) return
          sub.complete()
        })
      })
    }
    if (
      src != null &&
      (typeof src === 'object' || typeof src === 'string') &&
      typeof (src as {[Symbol.iterator]?: unknown})[Symbol.iterator] === 'function'
    ) {
      return new Observable<unknown>((sub) => {
        for (const value of src as Iterable<unknown>) {
          if (sub.closed) return
          sub.next(value)
        }
        if (!sub.closed) sub.complete()
      })
    }
    throw new TypeError('Observable.from: source must be a Promise, Iterable, or Observable')
  }

  static withEmitters<Ok, Err = never>(): {
    observable: Observable<Ok, Err>
    next: (value: unknown) => void
    complete: () => void
  } {
    const subs: Array<Subscriber<unknown>> = []
    let completed = false

    const observable = new Observable<unknown>((sub) => {
      if (completed) {
        sub.complete()
        return
      }
      subs.push(sub)
      sub.addTeardown(() => {
        const i = subs.indexOf(sub)
        if (i >= 0) subs.splice(i, 1)
      })
    })

    const next = (value: unknown) => {
      if (completed) return
      // Snapshot to be resilient against mid-dispatch unsubscribes.
      const snapshot = subs.slice()
      for (const s of snapshot) {
        if (!s.closed) s.next(value)
      }
    }

    const complete = () => {
      if (completed) return
      completed = true
      const snapshot = subs.slice()
      subs.length = 0
      for (const s of snapshot) {
        if (!s.closed) s.complete()
      }
    }

    return {observable: observable as unknown as Observable<Ok, Err>, next, complete}
  }
}
