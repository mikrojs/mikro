// Host-side shim for `mikro/observable/operators`, used only in vitest (Node)
// where the mikrojs C runtime isn't available. Keep in sync with the
// operators section of mik_observable.cpp: same argument checks, same
// subscription order, same completion rules.

import {Observable} from './native-observable.node-shim.js'
import type {Subscriber} from './types.js'

type Obs = Observable<unknown, unknown>
type Sub = Subscriber<unknown>
type Op = (source: Obs) => Obs
type Fn = (...args: unknown[]) => unknown
type EdgeOptions = {leading?: boolean; trailing?: boolean}

function isObservable(value: unknown): value is Obs {
  return value instanceof Observable
}

function requireFunction(name: string, fn: unknown): Fn {
  if (typeof fn !== 'function') throw new TypeError(`${name}: argument must be a function`)
  return fn as Fn
}

function requireCount(name: string, count: unknown): number {
  if (typeof count !== 'number') throw new TypeError(`${name}: count must be a number`)
  /* Non-finite or huge values saturate, NaN counts as 0. */
  return count > 0 ? Math.min(count, 0x7fffffff) : 0
}

function requireObservable(name: string, source: unknown): Obs {
  if (!isObservable(source)) throw new TypeError(`${name}: source must be an Observable`)
  return source
}

/* Subscribe `sub` to `source`: values go to `next`, completion to `complete`
 * (by default completing `sub`), and the upstream ends with `sub`. */
function forward(
  source: Obs,
  sub: Sub,
  next: (value: unknown) => void,
  complete: () => void = () => sub.complete(),
): void {
  Observable.forward(source, sub, {next, complete})
}

/* An operator: `setup` runs per subscription with the checked source. */
function operator(name: string, setup: (source: Obs, sub: Sub) => void): Op {
  return (source) => {
    const checked = requireObservable(name, source)
    return new Observable((sub) => setup(checked, sub))
  }
}

export function map(fn: unknown): Op {
  const project = requireFunction('map', fn)
  return operator('map', (source, sub) => forward(source, sub, (value) => sub.next(project(value))))
}

export function filter(fn: unknown): Op {
  const predicate = requireFunction('filter', fn)
  return operator('filter', (source, sub) =>
    forward(source, sub, (value) => {
      if (predicate(value)) sub.next(value)
    }),
  )
}

export function tap(fn: unknown): Op {
  const effect = requireFunction('tap', fn)
  return operator('tap', (source, sub) =>
    forward(source, sub, (value) => {
      effect(value)
      sub.next(value)
    }),
  )
}

export function take(count: unknown): Op {
  const limit = requireCount('take', count)
  return operator('take', (source, sub) => {
    if (limit === 0) {
      sub.complete()
      return
    }
    let remaining = limit
    forward(source, sub, (value) => {
      if (remaining <= 0) return
      remaining--
      sub.next(value)
      if (remaining === 0) sub.complete()
    })
  })
}

export function skip(count: unknown): Op {
  const limit = requireCount('skip', count)
  return operator('skip', (source, sub) => {
    let remaining = limit
    forward(source, sub, (value) => {
      if (remaining > 0) {
        remaining--
        return
      }
      sub.next(value)
    })
  })
}

export function scan(fn: unknown, seed: unknown): Op {
  const step = requireFunction('scan', fn)
  return operator('scan', (source, sub) => {
    let acc = seed
    forward(source, sub, (value) => {
      acc = step(acc, value)
      sub.next(acc)
    })
  })
}

export function distinctUntilChanged(fn?: unknown): Op {
  const equals =
    fn === undefined
      ? (a: unknown, b: unknown) => a === b
      : requireFunction('distinctUntilChanged', fn)
  return operator('distinctUntilChanged', (source, sub) => {
    let has = false
    let last: unknown
    forward(source, sub, (value) => {
      if (has && equals(last, value)) return
      has = true
      last = value
      sub.next(value)
    })
  })
}

export function startWith(value: unknown): Op {
  return operator('startWith', (source, sub) => {
    sub.next(value)
    if (!sub.closed) forward(source, sub, (v) => sub.next(v))
  })
}

export function finalize(fn: unknown): Op {
  const teardown = requireFunction('finalize', fn) as () => void
  return operator('finalize', (source, sub) => {
    /* Registered first, so it runs after the upstream unsubscribe. */
    sub.addTeardown(teardown)
    forward(source, sub, (value) => sub.next(value))
  })
}

export function takeUntil(until: unknown, options?: {inclusive?: boolean}): Op {
  if (typeof until === 'function') {
    const predicate = until as Fn
    const inclusive = options?.inclusive ?? true
    return operator('takeUntil', (source, sub) =>
      forward(source, sub, (value) => {
        const stop = predicate(value)
        if (!stop || inclusive) sub.next(value)
        if (stop) sub.complete()
      }),
    )
  }
  if (!isObservable(until)) {
    throw new TypeError('takeUntil: argument must be an Observable or a predicate')
  }
  return operator('takeUntil', (source, sub) => {
    /* Notifier first, as in RxJS: one that fires during its own subscribe
     * ends the stream before the source is subscribed. */
    forward(
      until,
      sub,
      () => sub.complete(),
      () => {},
    )
    forward(source, sub, (value) => sub.next(value))
  })
}

export function mergeWith(...others: unknown[]): Op {
  for (const other of others) {
    if (!isObservable(other)) throw new TypeError('mergeWith: arguments must be Observables')
  }
  return operator('mergeWith', (source, sub) => {
    let open = others.length + 1
    const complete = () => {
      if (--open === 0) sub.complete()
    }
    for (const stream of [source, ...(others as Obs[])]) {
      forward(stream, sub, (value) => sub.next(value), complete)
    }
  })
}

export function withLatestFrom(other: unknown): Op {
  if (!isObservable(other)) throw new TypeError('withLatestFrom: arguments must be Observables')
  return operator('withLatestFrom', (source, sub) => {
    let has = false
    let latest: unknown
    forward(
      other,
      sub,
      (value) => {
        has = true
        latest = value
      },
      () => {},
    )
    forward(source, sub, (value) => {
      if (has) sub.next([value, latest])
    })
  })
}

export function combineLatest(sources: unknown): Obs {
  if (!Array.isArray(sources) || !sources.every(isObservable)) {
    throw new TypeError('combineLatest: argument must be an array of Observables')
  }
  return new Observable((sub) => {
    const values = new Array<unknown>(sources.length)
    const seen = new Array<boolean>(sources.length).fill(false)
    let missing = sources.length
    let open = sources.length
    if (open === 0) {
      sub.next([])
      sub.complete()
      return
    }
    sources.forEach((source, i) => {
      /* A source that completed without a value already closed `sub`. */
      if (sub.closed) return
      forward(
        source,
        sub,
        (value) => {
          values[i] = value
          if (!seen[i]) {
            seen[i] = true
            missing--
          }
          if (missing === 0) sub.next(values.slice())
        },
        () => {
          if (!seen[i] || --open === 0) sub.complete()
        },
      )
    })
  })
}

export function pipe(...ops: unknown[]): Op {
  for (const op of ops) {
    if (typeof op !== 'function') throw new TypeError('pipe: arguments must be operator functions')
  }
  return (source) => source.pipe(...(ops as Op[]))
}

export function switchMap(fn: unknown): Op {
  const project = requireFunction('switchMap', fn)
  return operator('switchMap', (source, sub) => {
    let inner: {close(): void} | undefined
    let innerOpen = false
    let sourceDone = false
    /* Registered first, like the native state teardown: the inner ends after
     * the source upstream. */
    sub.addTeardown(() => inner?.close())
    forward(
      source,
      sub,
      (value) => {
        inner?.close()
        const stream = project(value)
        if (!isObservable(stream)) {
          throw new TypeError('switchMap: project must return an Observable')
        }
        innerOpen = true
        const started = Observable.start(stream, {
          next: (v: unknown) => sub.next(v),
          complete: () => {
            /* A queued completion of an inner already switched away drains
             * here too; only the current inner's completion counts. */
            if (inner !== started) return
            innerOpen = false
            if (sourceDone) sub.complete()
          },
        })
        inner = started
      },
      () => {
        sourceDone = true
        if (!innerOpen) sub.complete()
      },
    )
  })
}

function requireDuration(name: string, what: string, ms: unknown): number {
  if (typeof ms !== 'number') throw new TypeError(`${name}: ${what} must be a number`)
  return ms > 0 ? Math.min(ms, 0x7fffffff) : 0
}

export function timer(delayMs: unknown, periodMs?: unknown): Obs {
  if (typeof delayMs !== 'number' || (periodMs !== undefined && typeof periodMs !== 'number')) {
    throw new TypeError('timer: delay and period must be numbers')
  }
  return new Observable((sub) => {
    let count = 0
    let id = setTimeout(() => {
      sub.next(count++)
      /* The first value may have closed the chain (take(1), firstValueFrom):
       * the teardown has already run, so an interval opened now would leak. */
      if (sub.closed) return
      if (periodMs === undefined) {
        sub.complete()
        return
      }
      id = setInterval(() => sub.next(count++), periodMs)
    }, delayMs)
    /* Timeouts and intervals share one id space and one clear function. */
    sub.addTeardown(() => clearInterval(id))
  })
}

function edges(
  options: unknown,
  leading: boolean,
  trailing: boolean,
): {leading: boolean; trailing: boolean} {
  if (typeof options !== 'object' || options === null) return {leading, trailing}
  const given = options as EdgeOptions
  return {leading: given.leading ?? leading, trailing: given.trailing ?? trailing}
}

export function debounceTime(ms: unknown, options?: unknown): Op {
  const window = requireDuration('debounceTime', 'duration', ms)
  const {leading, trailing} = edges(options, false, true)
  return operator('debounceTime', (source, sub) => {
    let id: ReturnType<typeof setTimeout> | undefined
    let pending = false
    let last: unknown
    const flush = () => {
      id = undefined
      if (!pending) return
      pending = false
      sub.next(last)
    }
    sub.addTeardown(() => {
      if (id !== undefined) clearTimeout(id)
    })
    forward(
      source,
      sub,
      (value) => {
        const quiet = id === undefined
        if (id !== undefined) clearTimeout(id)
        id = setTimeout(flush, window)
        if (quiet && leading) {
          sub.next(value)
          return
        }
        last = value
        pending = trailing
      },
      () => {
        if (id !== undefined) clearTimeout(id)
        flush()
        sub.complete()
      },
    )
  })
}

export function throttleTime(ms: unknown, options?: unknown): Op {
  const window = requireDuration('throttleTime', 'duration', ms)
  const {leading, trailing} = edges(options, true, false)
  return operator('throttleTime', (source, sub) => {
    let id: ReturnType<typeof setTimeout> | undefined
    let pending = false
    let last: unknown
    const open = () => {
      id = setTimeout(() => {
        id = undefined
        if (!pending) return
        pending = false
        sub.next(last)
        if (!sub.closed) open()
      }, window)
    }
    sub.addTeardown(() => {
      if (id !== undefined) clearTimeout(id)
    })
    forward(
      source,
      sub,
      (value) => {
        if (id !== undefined) {
          last = value
          pending = trailing
          return
        }
        if (leading) {
          sub.next(value)
        } else {
          last = value
          pending = trailing
        }
        if (!sub.closed) open()
      },
      () => {
        if (id !== undefined) clearTimeout(id)
        if (pending) sub.next(last)
        sub.complete()
      },
    )
  })
}
