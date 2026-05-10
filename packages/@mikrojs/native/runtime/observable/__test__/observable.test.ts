import {Observable} from 'mikrojs/observable'
import {filter, finalize, map, take, takeUntil} from 'mikrojs/observable/operators'
import {describe, expect, test, vi} from 'vitest'

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

  test('observer.next throw is caught + logged, dispatch continues', () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
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
    expect(seen).toEqual([1, 2, 3])
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  test('teardown throw does not stop subsequent teardowns', () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
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
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
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

  test('map fn throw is logged and that value is dropped', () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: number[] = []
    Observable.from([1, 2, 3])
      .pipe(
        map((v) => {
          if (v === 2) throw new Error('boom')
          return v
        }),
      )
      .subscribe((v) => seen.push(v))
    expect(seen).toEqual([1, 3])
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })
})
