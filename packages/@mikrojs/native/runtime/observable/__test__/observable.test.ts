import {Observable} from 'mikro/observable'
import {filter, finalize, map, take, takeUntil} from 'mikro/observable/operators'
import {describe, expect, test, vi} from 'vitest'

/* Capture setTimeout calls so tests can assert that dispatch errors are
 * scheduled to re-throw async without those throws actually firing during
 * the test. The captured fn() can be invoked to verify it throws. */
function captureScheduledThrows() {
  const calls: Array<{fn: () => void; ms: number}> = []
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms: number,
  ) => {
    calls.push({fn, ms})
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  return {
    calls,
    restore: () => spy.mockRestore(),
  }
}

describe('Observable primitive', () => {
  test('subscribe delivers next + complete in order', () => {
    const log: Array<number | string> = []
    new Observable<number>((sub) => {
      sub.next(1)
      sub.next(2)
      sub.complete()
    }).subscribe({
      next: (v) => log.push(v),
      complete: () => log.push('done'),
    })
    expect(log).toEqual([1, 2, 'done'])
  })

  test('subscribe accepts a function shorthand', () => {
    const seen: number[] = []
    new Observable<number>((sub) => {
      sub.next(42)
      sub.complete()
    }).subscribe((v) => seen.push(v))
    expect(seen).toEqual([42])
  })

  test('subscribe with no observer still runs the producer callback', () => {
    let ran = false
    new Observable<number>((sub) => {
      ran = true
      sub.complete()
    }).subscribe()
    expect(ran).toBe(true)
  })

  test('next after complete is a no-op', () => {
    const seen: number[] = []
    new Observable<number>((sub) => {
      sub.next(1)
      sub.complete()
      sub.next(2)
      sub.next(3)
    }).subscribe((v) => seen.push(v))
    expect(seen).toEqual([1])
  })

  test('teardowns run in reverse insertion order on complete', () => {
    const trace: string[] = []
    new Observable<number>((sub) => {
      sub.addTeardown(() => trace.push('a'))
      sub.addTeardown(() => trace.push('b'))
      sub.addTeardown(() => trace.push('c'))
      sub.complete()
    }).subscribe()
    expect(trace).toEqual(['c', 'b', 'a'])
  })

  test('unsubscribe runs teardowns but not observer.complete', () => {
    const trace: string[] = []
    const sub = new Observable<number>((s) => {
      s.addTeardown(() => trace.push('teardown'))
    }).subscribe({
      next: () => {},
      complete: () => trace.push('observerComplete'),
    })
    sub.unsubscribe()
    expect(trace).toEqual(['teardown'])
  })

  test('unsubscribe is idempotent', () => {
    let count = 0
    const sub = new Observable<number>((s) => {
      s.addTeardown(() => {
        count++
      })
    }).subscribe()
    sub.unsubscribe()
    sub.unsubscribe()
    sub.unsubscribe()
    expect(count).toBe(1)
  })

  test('observer.next throw panics and stops delivery', () => {
    const captured = captureScheduledThrows()
    const seen: number[] = []
    new Observable<number>((sub) => {
      sub.next(1)
      sub.next(2)
      sub.next(3)
      sub.complete()
    }).subscribe((v) => {
      seen.push(v)
      if (v === 1) throw new Error('boom')
    })
    /* The crash stops delivery; 2 and 3 never arrive. */
    expect(seen).toEqual([1])
    /* The host sees the error as an uncaught throw on the next tick. */
    expect(captured.calls).toHaveLength(1)
    expect(captured.calls[0]!.ms).toBe(0)
    expect(() => captured.calls[0]!.fn()).toThrow('boom')
    captured.restore()
  })

  test('teardown throw panics but the remaining teardowns still run', () => {
    const captured = captureScheduledThrows()
    const trace: string[] = []
    new Observable<number>((sub) => {
      sub.addTeardown(() => trace.push('a'))
      sub.addTeardown(() => {
        throw new Error('mid')
      })
      sub.addTeardown(() => trace.push('c'))
      sub.complete()
    }).subscribe()
    expect(trace).toEqual(['c', 'a'])
    expect(captured.calls).toHaveLength(1)
    expect(() => captured.calls[0]!.fn()).toThrow('mid')
    captured.restore()
  })

  test('producer setup throw bubbles to subscribe caller', () => {
    expect(() =>
      new Observable<number>(() => {
        throw new Error('producer-fail')
      }).subscribe(),
    ).toThrow('producer-fail')
  })
})

describe('Observable.from', () => {
  test('iterable drains synchronously', () => {
    const log: Array<number | string> = []
    Observable.from([10, 20, 30]).subscribe({
      next: (v) => log.push(v),
      complete: () => log.push('done'),
    })
    expect(log).toEqual([10, 20, 30, 'done'])
  })

  test('promise emits then completes', async () => {
    const log: Array<unknown> = []
    Observable.from(Promise.resolve('hi')).subscribe({
      next: (v) => log.push(v),
      complete: () => log.push('done'),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(log).toEqual(['hi', 'done'])
  })

  test('passthrough on Observable instances', () => {
    const a = new Observable<number>((sub) => {
      sub.next(1)
      sub.complete()
    })
    const b = Observable.from(a)
    expect(b).toBe(a)
  })

  test('rejects unsupported sources', () => {
    expect(() => Observable.from(42 as unknown as Iterable<number>)).toThrow(
      /Promise, Iterable, or Observable/,
    )
  })
})

describe('Observable.withEmitters', () => {
  test('multicasts to multiple subscribers', () => {
    const {observable, next} = Observable.withEmitters<number>()
    const a: number[] = []
    const b: number[] = []
    observable.subscribe((v) => a.push(v))
    observable.subscribe((v) => b.push(v))
    next(1)
    next(2)
    next(3)
    expect(a).toEqual([1, 2, 3])
    expect(b).toEqual([1, 2, 3])
  })

  test('late subscriber after complete gets immediate complete', () => {
    const {observable, next, complete} = Observable.withEmitters<number>()
    next(1)
    complete()
    const log: Array<number | string> = []
    observable.subscribe({
      next: (v) => log.push(v),
      complete: () => log.push('done'),
    })
    expect(log).toEqual(['done'])
  })

  test('complete is idempotent and stops further next', () => {
    const {observable, next, complete} = Observable.withEmitters<string>()
    let count = 0
    observable.subscribe({
      next: () => {},
      complete: () => {
        count++
      },
    })
    complete()
    complete()
    complete()
    next('after-complete')
    expect(count).toBe(1)
  })

  test('unsubscribed subscriber stops receiving values', () => {
    const {observable, next} = Observable.withEmitters<number>()
    const seen: number[] = []
    const sub = observable.subscribe((v) => seen.push(v))
    next(1)
    sub.unsubscribe()
    next(2)
    expect(seen).toEqual([1])
  })
})

/* The shim mirrors the C dispatch queue in mik_observable.cpp; these pin the
 * ordering consequences so host and device cannot drift apart. Each has a
 * counterpart in test/observable_test.cpp. */
describe('dispatch queue', () => {
  test('handler code after sub.next() runs before downstream delivery', () => {
    const log: string[] = []
    const relay = (source: Observable<number>): Observable<number> =>
      new Observable<number>((sub) => {
        const upstream = source.subscribe({
          next: (v) => {
            log.push(`before:${v}`)
            sub.next(v)
            log.push(`after:${v}`)
          },
          complete: () => sub.complete(),
        })
        sub.addTeardown(() => upstream.unsubscribe())
      })

    new Observable<number>((s) => {
      s.next(1)
      s.next(2)
      s.complete()
    })
      .pipe(relay)
      .subscribe((v) => log.push(`down:${v}`))

    expect(log).toEqual(['before:1', 'after:1', 'down:1', 'before:2', 'after:2', 'down:2'])
  })

  test('queued delivery is dropped when the subscriber unsubscribes first', () => {
    const {observable, next} = Observable.withEmitters<number>()
    const aLog: number[] = []
    const bLog: number[] = []

    const subs: {b?: {unsubscribe: () => void}} = {}
    observable.subscribe((v) => {
      if (v === 1) {
        next(2)
        subs.b?.unsubscribe()
      }
      aLog.push(v)
    })
    subs.b = observable.subscribe((v) => bLog.push(v))
    next(1)

    expect(aLog).toEqual([1, 2])
    expect(bLog).toEqual([])
  })

  test('subscribing to a sync source inside a handler defers its values', () => {
    const log: string[] = []
    new Observable<string>((s) => {
      s.next('go')
      s.complete()
    }).subscribe(() => {
      let got: number | string = 'none'
      Observable.from([7]).subscribe((x) => {
        got = x as number
      })
      log.push(`inline:${got}`)
    })

    expect(log).toEqual(['inline:none'])
  })

  test('producer that completes then throws still delivers the completion', () => {
    const log: string[] = []
    new Observable<string>((outer) => {
      outer.next('go')
      outer.complete()
    }).subscribe(() => {
      try {
        new Observable<never>((sub) => {
          sub.addTeardown(() => log.push('td'))
          sub.complete()
          throw new Error('setup-fail')
        }).subscribe({complete: () => log.push('c')})
      } catch {
        log.push('caught')
      }
    })

    expect(log).toEqual(['caught', 'c', 'td'])
  })
})

describe('pipe + operators', () => {
  test('map transforms values', () => {
    const seen: number[] = []
    Observable.from([1, 2, 3])
      .pipe(map((v) => v * 10))
      .subscribe((v) => seen.push(v))
    expect(seen).toEqual([10, 20, 30])
  })

  test('filter drops values', () => {
    const seen: number[] = []
    Observable.from([1, 2, 3, 4])
      .pipe(filter((v) => v % 2 === 0))
      .subscribe((v) => seen.push(v))
    expect(seen).toEqual([2, 4])
  })

  test('take limits emissions and completes', () => {
    const log: Array<number | string> = []
    Observable.from([1, 2, 3, 4, 5])
      .pipe(take(2))
      .subscribe({
        next: (v) => log.push(v),
        complete: () => log.push('done'),
      })
    expect(log).toEqual([1, 2, 'done'])
  })

  test('take(0) completes immediately', () => {
    const log: Array<number | string> = []
    Observable.from([1, 2, 3])
      .pipe(take(0))
      .subscribe({
        next: (v) => log.push(v),
        complete: () => log.push('done'),
      })
    expect(log).toEqual(['done'])
  })

  test('takeUntil stops when notifier emits', () => {
    const {observable: source, next: emit} = Observable.withEmitters<number>()
    const {observable: stop, next: stopNow} = Observable.withEmitters<void>()
    const log: Array<number | string> = []
    source.pipe(takeUntil(stop)).subscribe({
      next: (v) => log.push(v),
      complete: () => log.push('done'),
    })
    emit(1)
    emit(2)
    stopNow()
    emit(3) // no longer received
    expect(log).toEqual([1, 2, 'done'])
  })

  test('takeUntil leaves source alone if notifier merely completes', () => {
    const {observable: source, next: emit} = Observable.withEmitters<number>()
    const empty = Observable.from<number>([]) // completes without emitting
    const seen: number[] = []
    source.pipe(takeUntil(empty)).subscribe((v) => seen.push(v))
    emit(1)
    emit(2)
    expect(seen).toEqual([1, 2])
  })

  test('finalize fires on natural completion', () => {
    const events: string[] = []
    Observable.from([1, 2])
      .pipe(finalize(() => events.push('finalized')))
      .subscribe({
        next: (v) => events.push(`v:${v}`),
        complete: () => events.push('done'),
      })
    /* finalize runs as a teardown, after observer.complete. */
    expect(events).toEqual(['v:1', 'v:2', 'done', 'finalized'])
  })

  test('finalize fires on unsubscribe', () => {
    const {observable, next} = Observable.withEmitters<number>()
    const events: string[] = []
    const sub = observable
      .pipe(finalize(() => events.push('finalized')))
      .subscribe((v) => events.push(`v:${v}`))
    next(1)
    sub.unsubscribe()
    next(2) // no longer received
    expect(events).toEqual(['v:1', 'finalized'])
  })

  test('chains compose left to right', () => {
    const seen: number[] = []
    Observable.from([1, 2, 3, 4, 5])
      .pipe(
        map((v) => v + 1),
        filter((v) => v % 2 === 0),
        take(2),
      )
      .subscribe((v) => seen.push(v))
    /* +1 -> [2,3,4,5,6], filter even -> [2,4,6], take 2 -> [2,4] */
    expect(seen).toEqual([2, 4])
  })

  test('pipe with no operators returns source-equivalent', () => {
    const seen: number[] = []
    Observable.from([1, 2])
      .pipe()
      .subscribe((v) => seen.push(v))
    expect(seen).toEqual([1, 2])
  })

  test('map fn throw panics and stops delivery', () => {
    const captured = captureScheduledThrows()
    const seen: number[] = []
    Observable.from([1, 2, 3])
      .pipe(
        map((value) => {
          if (value === 2) throw new Error('boom')
          return value
        }),
      )
      .subscribe((value) => seen.push(value))
    // 3 is never pulled: the crash stops the source mid-drain.
    expect(seen).toEqual([1])
    expect(captured.calls).toHaveLength(1)
    expect(() => captured.calls[0]!.fn()).toThrow('boom')
    captured.restore()
  })
})
