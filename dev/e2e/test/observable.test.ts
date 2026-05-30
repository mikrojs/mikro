import {Observable} from 'mikro/observable'
import {filter, finalize, map, take, takeUntil} from 'mikro/observable/operators'
import {assert, describe, test} from 'mikro/test'

/* On-device sanity for the Observable runtime: verifies the C++ class
 * registers under `native:observable`, the operator bytecode bundle loads
 * and runs, and the runtime's microtask + Promise integration behaves the
 * same as the host doctests. The exhaustive behavioral coverage lives in
 * packages/@mikrojs/native/test/observable_test.cpp; this file only checks
 * the integration paths most likely to drift between host and device. */

describe('observable', () => {
  test('subscribe delivers next then complete', () => {
    const seen: number[] = []
    let completed = false
    new Observable<number>((sub) => {
      sub.next(1)
      sub.next(2)
      sub.next(3)
      sub.complete()
    }).subscribe({
      next: (v) => seen.push(v),
      complete: () => {
        completed = true
      },
    })
    assert.equal(seen.join(','), '1,2,3')
    assert.equal(completed, true)
  })

  test('unsubscribe stops delivery and runs teardown', () => {
    const seen: number[] = []
    let teardownCount = 0
    let producerNext: ((v: number) => void) | null = null
    const sub = new Observable<number>((s) => {
      producerNext = (v) => s.next(v)
      s.addTeardown(() => {
        teardownCount++
      })
    }).subscribe((v) => seen.push(v))

    producerNext!(1)
    sub.unsubscribe()
    producerNext!(2)
    /* idempotent */
    sub.unsubscribe()

    assert.equal(seen.join(','), '1')
    assert.equal(teardownCount, 1)
  })

  test('pipe(map, filter, take) composes', () => {
    const seen: number[] = []
    let completed = false
    new Observable<number>((sub) => {
      for (let i = 1; i <= 10; i++) sub.next(i)
      sub.complete()
    })
      .pipe(
        map((x: number) => x * 2),
        filter((x: number) => x > 4),
        take(3),
      )
      .subscribe({
        next: (v) => seen.push(v),
        complete: () => {
          completed = true
        },
      })
    /* 1..10 → 2,4,6,8,10,12,14,16,18,20 → 6,8,10,12,14,16,18,20 → 6,8,10 */
    assert.equal(seen.join(','), '6,8,10')
    assert.equal(completed, true)
  })

  test('takeUntil completes when notifier emits', () => {
    const seen: number[] = []
    let completed = false
    let notify: () => void = () => {}
    const notifier = new Observable<void>((sub) => {
      notify = () => sub.next()
    })

    let producerNext: ((v: number) => void) | null = null
    new Observable<number>((sub) => {
      producerNext = (v) => sub.next(v)
    })
      .pipe(takeUntil(notifier))
      .subscribe({
        next: (v) => seen.push(v),
        complete: () => {
          completed = true
        },
      })

    producerNext!(1)
    producerNext!(2)
    notify()
    producerNext!(3)

    assert.equal(seen.join(','), '1,2')
    assert.equal(completed, true)
  })

  test('finalize runs on natural completion', () => {
    let finalized = 0
    new Observable<number>((sub) => {
      sub.next(1)
      sub.complete()
    })
      .pipe(finalize(() => finalized++))
      .subscribe()
    assert.equal(finalized, 1)
  })

  test('finalize runs on unsubscribe', () => {
    let finalized = 0
    const sub = new Observable<number>(() => {
      /* never emits */
    })
      .pipe(finalize(() => finalized++))
      .subscribe()
    sub.unsubscribe()
    assert.equal(finalized, 1)
  })

  test('Observable.from(iterable) drains synchronously', () => {
    const seen: number[] = []
    let completed = false
    Observable.from([10, 20, 30]).subscribe({
      next: (v) => seen.push(v),
      complete: () => {
        completed = true
      },
    })
    assert.equal(seen.join(','), '10,20,30')
    assert.equal(completed, true)
  })

  test('Observable.from(promise) emits then completes', async () => {
    const seen: number[] = []
    let completed = false
    Observable.from(Promise.resolve(42)).subscribe({
      next: (v) => seen.push(v),
      complete: () => {
        completed = true
      },
    })
    /* Yield once so the promise resolution microtask runs and dispatches
     * next + complete to the subscriber. */
    await Promise.resolve()
    assert.equal(seen.join(','), '42')
    assert.equal(completed, true)
  })

  test('withEmitters multicasts to all subscribers', () => {
    const a: number[] = []
    const b: number[] = []
    const {observable, next, complete} = Observable.withEmitters<number>()
    observable.subscribe((v) => a.push(v))
    observable.subscribe((v) => b.push(v))
    next(1)
    next(2)
    complete()
    assert.equal(a.join(','), '1,2')
    assert.equal(b.join(','), '1,2')
  })

  test('withEmitters: late subscriber after complete completes immediately', () => {
    let lateCompleted = false
    const {observable, complete} = Observable.withEmitters<number>()
    complete()
    observable.subscribe({
      next: () => {
        /* unreachable */
      },
      complete: () => {
        lateCompleted = true
      },
    })
    assert.equal(lateCompleted, true)
  })
})
