import {Observable, of} from 'mikro/observable'
import {
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  filter,
  map,
  mergeWith,
  pipe,
  scan,
  skip,
  startWith,
  switchMap,
  take,
  takeUntil,
  tap,
  throttleTime,
  timer,
  withLatestFrom,
} from 'mikro/observable/operators'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

function collect<T>(source: Observable<T>): unknown[] {
  const seen: unknown[] = []
  source.subscribe({next: (v) => seen.push(v), complete: () => seen.push('done')})
  return seen
}

/* A source that records whether its subscriber has torn down. */
function tracked<T>() {
  const {observable, next, complete} = Observable.withEmitters<T>()
  let released = false
  const wrapped = new Observable<T>((sub) => {
    const up = observable.subscribe({next: (v) => sub.next(v), complete: () => sub.complete()})
    sub.addTeardown(() => {
      up.unsubscribe()
      released = true
    })
  })
  return {observable: wrapped, next, complete, released: () => released}
}

describe('operators', () => {
  test('pipe composes operators left to right', () => {
    const op = pipe(
      map((n: number) => n + 1),
      map((n) => `${n}`),
    )
    expect(collect(op(of(1, 2)))).toEqual(['2', '3', 'done'])
  })

  test('of emits its values then completes', () => {
    expect(collect(of('a', 'b'))).toEqual(['a', 'b', 'done'])
  })

  test('startWith emits first, then passes the source through', () => {
    expect(collect(of(2, 3).pipe(startWith(1)))).toEqual([1, 2, 3, 'done'])
  })

  test('startWith never subscribes a source the chain no longer needs', () => {
    let setups = 0
    const source = new Observable<number>((sub) => {
      setups++
      sub.next(9)
    })
    expect(collect(source.pipe(startWith(0), take(1)))).toEqual([0, 'done'])
    expect(setups).toBe(0)
  })

  test('scan emits each intermediate accumulator', () => {
    expect(collect(of(1, 2, 3).pipe(scan((acc: number, n: number) => acc + n, 10)))).toEqual([
      11,
      13,
      16,
      'done',
    ])
  })

  test('combineLatest waits for every source, then emits on each change', () => {
    const a = Observable.withEmitters<number>()
    const b = Observable.withEmitters<string>()
    const seen = collect(combineLatest([a.observable, b.observable]))
    a.next(1)
    expect(seen).toEqual([])
    b.next('x')
    a.next(2)
    a.complete()
    b.next('y')
    b.complete()
    expect(seen).toEqual([[1, 'x'], [2, 'x'], [2, 'y'], 'done'])
  })

  test('combineLatest of nothing emits an empty tuple', () => {
    expect(collect(combineLatest([]))).toEqual([[], 'done'])
  })

  test('combineLatest completes as soon as a source ends without a value', () => {
    const a = Observable.withEmitters<number>()
    const b = tracked<string>()
    const seen = collect(combineLatest([a.observable, b.observable]))
    a.next(1)
    a.complete()
    expect(seen).toEqual([])
    b.complete()
    expect(seen).toEqual(['done'])
    expect(b.released()).toBe(true)
  })

  test('unsubscribing from combineLatest releases every source', () => {
    const a = tracked<number>()
    const b = tracked<number>()
    const sub = combineLatest([a.observable, b.observable]).subscribe()
    sub.unsubscribe()
    expect(a.released()).toBe(true)
    expect(b.released()).toBe(true)
  })

  test('distinctUntilChanged drops repeats of the previous value', () => {
    expect(collect(of(1, 1, 2, 2, 1).pipe(distinctUntilChanged()))).toEqual([1, 2, 1, 'done'])
  })

  test('mergeWith interleaves sources and completes after all of them', () => {
    const a = Observable.withEmitters<number>()
    const b = Observable.withEmitters<number>()
    const seen = collect(a.observable.pipe(mergeWith(b.observable)))
    a.next(1)
    b.next(2)
    a.next(3)
    a.complete()
    expect(seen).toEqual([1, 2, 3])
    b.next(4)
    b.complete()
    expect(seen).toEqual([1, 2, 3, 4, 'done'])
  })

  test('unsubscribing from mergeWith releases every source', () => {
    const a = tracked<number>()
    const b = tracked<number>()
    const sub = a.observable.pipe(mergeWith(b.observable)).subscribe()
    sub.unsubscribe()
    expect(a.released()).toBe(true)
    expect(b.released()).toBe(true)
  })

  test('withLatestFrom drops values until the other side has one', () => {
    const source = Observable.withEmitters<number>()
    const other = Observable.withEmitters<string>()
    const seen = collect(source.observable.pipe(withLatestFrom(other.observable)))
    source.next(1)
    other.next('a')
    source.next(2)
    other.next('b')
    source.next(3)
    expect(seen).toEqual([
      [2, 'a'],
      [3, 'b'],
    ])
  })

  test('unsubscribing from withLatestFrom releases both sides', () => {
    const source = tracked<number>()
    const other = tracked<string>()
    const sub = source.observable.pipe(withLatestFrom(other.observable)).subscribe()
    sub.unsubscribe()
    expect(source.released()).toBe(true)
    expect(other.released()).toBe(true)
  })

  test('filter narrows with a type guard', () => {
    const isNumber = (v: unknown): v is number => typeof v === 'number'
    const seen: number[] = []
    of<unknown>(1, 'a', 2)
      .pipe(filter(isNumber))
      .subscribe((n) => seen.push(n))
    expect(seen).toEqual([1, 2])
  })

  test('skip drops the first values', () => {
    expect(collect(of(1, 2, 3).pipe(skip(2)))).toEqual([3, 'done'])
  })

  test('tap sees each value and leaves the stream unchanged', () => {
    const tapped: number[] = []
    expect(collect(of(1, 2).pipe(tap((n) => tapped.push(n))))).toEqual([1, 2, 'done'])
    expect(tapped).toEqual([1, 2])
  })

  test('switchMap follows the latest inner stream and releases the previous one', () => {
    const source = Observable.withEmitters<number>()
    const inners: Array<ReturnType<typeof tracked<string>>> = []
    const seen = collect(
      source.observable.pipe(
        switchMap(() => {
          const inner = tracked<string>()
          inners.push(inner)
          return inner.observable
        }),
      ),
    )
    source.next(1)
    inners[0]!.next('a')
    source.next(2)
    expect(inners[0]!.released()).toBe(true)
    inners[0]!.next('stale')
    inners[1]!.next('b')
    expect(seen).toEqual(['a', 'b'])
  })

  test('switchMap completes after both the source and the last inner stream', () => {
    const source = Observable.withEmitters<number>()
    const inner = Observable.withEmitters<string>()
    const seen = collect(source.observable.pipe(switchMap(() => inner.observable)))
    source.next(1)
    source.complete()
    expect(seen).toEqual([])
    inner.next('a')
    inner.complete()
    expect(seen).toEqual(['a', 'done'])
  })

  test('switchMap over synchronous inner streams keeps order', () => {
    expect(collect(of(1, 2).pipe(switchMap((n) => of(n, n * 10))))).toEqual([1, 10, 2, 20, 'done'])
  })

  test("switchMap ignores a switched-away inner stream's queued completion", () => {
    /* The inner switchMap is subscribed inside a dispatch, so of(1, 2)'s
     * values are queued and inner 1 completes while queued. */
    expect(
      collect(of(0).pipe(switchMap(() => of(1, 2).pipe(switchMap((n) => of(n, n * 10)))))),
    ).toEqual([1, 10, 2, 20, 'done'])
  })

  test('takeUntil subscribes the notifier before the source', () => {
    let setups = 0
    const source = new Observable<number>((sub) => {
      setups++
      sub.next(1)
    })
    expect(collect(source.pipe(takeUntil(of('x'))))).toEqual(['done'])
    expect(setups).toBe(0)
  })
})

describe('timer operators', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('timer emits once after the delay and completes', () => {
    const seen = collect(timer(100))
    vi.advanceTimersByTime(99)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([0, 'done'])
  })

  test('timer with a period keeps counting until unsubscribed', () => {
    const seen: number[] = []
    const sub = timer(50, 10).subscribe((n) => seen.push(n))
    vi.advanceTimersByTime(70)
    expect(seen).toEqual([0, 1, 2])
    sub.unsubscribe()
    vi.advanceTimersByTime(50)
    expect(seen).toEqual([0, 1, 2])
  })

  test('timer opens no interval when its first value closes the chain', () => {
    timer(0, 10).pipe(take(1)).subscribe()
    vi.advanceTimersByTime(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('unsubscribing before the delay cancels the timer', () => {
    const seen: number[] = []
    const sub = timer(100).subscribe((n) => seen.push(n))
    sub.unsubscribe()
    vi.advanceTimersByTime(200)
    expect(seen).toEqual([])
  })

  test('debounceTime emits the last value once the source goes quiet', () => {
    const source = Observable.withEmitters<number>()
    const seen = collect(source.observable.pipe(debounceTime(20)))
    source.next(1)
    vi.advanceTimersByTime(10)
    source.next(2)
    vi.advanceTimersByTime(19)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([2])
    source.next(3)
    source.complete()
    expect(seen).toEqual([2, 3, 'done'])
  })

  test('throttleTime passes the first value and drops the rest of the window', () => {
    const source = Observable.withEmitters<number>()
    const seen = collect(source.observable.pipe(throttleTime(20)))
    source.next(1)
    source.next(2)
    vi.advanceTimersByTime(19)
    source.next(3)
    expect(seen).toEqual([1])
    vi.advanceTimersByTime(1)
    source.next(4)
    expect(seen).toEqual([1, 4])
  })

  test('debounceTime leading emits the first of a burst at once, trailing the last', () => {
    const source = Observable.withEmitters<number>()
    const seen = collect(source.observable.pipe(debounceTime(20, {leading: true})))
    source.next(1)
    expect(seen).toEqual([1])
    source.next(2)
    source.next(3)
    vi.advanceTimersByTime(20)
    expect(seen).toEqual([1, 3])
    /* A lone value is not emitted twice. */
    source.next(4)
    vi.advanceTimersByTime(20)
    expect(seen).toEqual([1, 3, 4])
  })

  test('debounceTime leading without trailing drops the rest of the burst', () => {
    const source = Observable.withEmitters<number>()
    const seen = collect(source.observable.pipe(debounceTime(20, {leading: true, trailing: false})))
    source.next(1)
    source.next(2)
    vi.advanceTimersByTime(20)
    source.complete()
    expect(seen).toEqual([1, 'done'])
  })

  test('throttleTime trailing emits the last dropped value when the window ends', () => {
    const source = Observable.withEmitters<number>()
    const seen = collect(source.observable.pipe(throttleTime(20, {trailing: true})))
    source.next(1)
    source.next(2)
    source.next(3)
    expect(seen).toEqual([1])
    vi.advanceTimersByTime(20)
    expect(seen).toEqual([1, 3])
    /* The trailing emission opened a new window. */
    source.next(4)
    expect(seen).toEqual([1, 3])
    vi.advanceTimersByTime(20)
    expect(seen).toEqual([1, 3, 4])
  })

  test('throttleTime trailing only waits for the window before the first emission', () => {
    const source = Observable.withEmitters<number>()
    const seen = collect(source.observable.pipe(throttleTime(20, {leading: false, trailing: true})))
    source.next(1)
    source.next(2)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(20)
    expect(seen).toEqual([2])
    source.next(3)
    source.complete()
    expect(seen).toEqual([2, 3, 'done'])
  })
})
