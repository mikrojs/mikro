import {Observable, state} from 'mikro/observable'
import {mergeWith, pipe, scan, startWith, take} from 'mikro/observable/operators'
import {describe, expect, test} from 'vitest'

describe('state', () => {
  test('replays the current value to each new subscriber', () => {
    const [count, setCount] = state(startWith(0))
    const a: number[] = []
    count.subscribe((v) => a.push(v))
    setCount(1)
    setCount(2)
    const b: number[] = []
    count.subscribe((v) => b.push(v))
    expect(a).toEqual([0, 1, 2])
    expect(b).toEqual([2])
  })

  test('is hot: values pushed before any subscriber are kept', () => {
    const [letter, setLetter] = state(startWith('a'))
    setLetter('b')
    const seen: string[] = []
    letter.subscribe((v) => seen.push(v))
    expect(seen).toEqual(['b'])
  })

  test('has no value until the pipeline produces one', () => {
    const [reading, setReading] = state<number, number>((s) => s)
    const seen: number[] = []
    reading.subscribe((v) => seen.push(v))
    expect(seen).toEqual([])
    setReading(5)
    expect(seen).toEqual([5])
  })

  test('reducer form: inputs and outputs may differ', () => {
    type Action = 'inc' | 'dec' | 'reset'
    const reduce = (n: number, a: Action) => (a === 'reset' ? 0 : a === 'inc' ? n + 1 : n - 1)
    const [count, dispatch] = state(pipe(scan(reduce, 0), startWith(0)))
    const seen: number[] = []
    count.subscribe((v) => seen.push(v))
    dispatch('inc')
    dispatch('inc')
    dispatch('dec')
    dispatch('reset')
    expect(seen).toEqual([0, 1, 2, 1, 0])
  })

  test('complete reaches live subscribers and late ones after the value', () => {
    const [level, setLevel, complete] = state(startWith(1))
    const live: unknown[] = []
    level.subscribe({next: (v) => live.push(v), complete: () => live.push('done')})
    setLevel(2)
    complete()
    const late: unknown[] = []
    level.subscribe({next: (v) => late.push(v), complete: () => late.push('done')})
    expect(live).toEqual([1, 2, 'done'])
    expect(late).toEqual([2, 'done'])
  })

  test('complete stops a pipeline that merges a source which never completes', () => {
    const {observable, next} = Observable.withEmitters<number>()
    let released = false
    const endless = new Observable<number>((s) => {
      const up = observable.subscribe((v) => s.next(v))
      s.addTeardown(() => {
        up.unsubscribe()
        released = true
      })
    })
    const [total, add, complete] = state(
      pipe(
        mergeWith(endless),
        scan((n: number, d: number) => n + d, 0),
        startWith(0),
      ),
    )
    const seen: unknown[] = []
    total.subscribe({next: (v) => seen.push(v), complete: () => seen.push('done')})
    add(1)
    next(2)
    complete()
    next(3)
    expect(seen).toEqual([0, 1, 3, 'done'])
    expect(released).toBe(true)
  })

  test('a completed holder ignores writes, however it completed', () => {
    const [count, setCount, complete] = state(startWith(0))
    setCount(1)
    complete()
    setCount(2)
    const seen: unknown[] = []
    count.subscribe({next: (v) => seen.push(v), complete: () => seen.push('done')})
    expect(seen).toEqual([1, 'done'])

    const [first, setFirst] = state(pipe(startWith('a'), take(2)))
    setFirst('b') // second value; take(2) completes the pipeline
    setFirst('c')
    const late: unknown[] = []
    first.subscribe({next: (v) => late.push(v), complete: () => late.push('done')})
    expect(late).toEqual(['b', 'done'])
  })

  test('an unsubscribed subscriber stops receiving values', () => {
    const [count, setCount] = state(startWith(0))
    const seen: number[] = []
    const sub = count.subscribe((v) => seen.push(v))
    setCount(1)
    sub.unsubscribe()
    setCount(2)
    expect(seen).toEqual([0, 1])
  })
})
