import type {Observable, Subscriber, Subscription} from '@mikrojs/native/runtime/observable/types'
import {filter, map, pipe} from 'mikro/observable/operators'
import type {Result} from 'mikro/result'
import {expectTypeOf, test} from 'vitest'

declare const observable: Observable<number>
declare const fallible: Observable<number, MyError>
declare const mixed: Observable<unknown>
declare const _sub: Subscriber<string>
declare const _fallibleSub: Subscriber<string, MyError>

type MyError = {name: 'NetworkError'} | {name: 'ParseError'}

test('subscribe shape on non-fallible Observable', () => {
  const s: Subscription = observable.subscribe((v) => {
    expectTypeOf(v).toEqualTypeOf<number>()
  })
  expectTypeOf(s.unsubscribe).toBeFunction()

  observable.subscribe({
    next: (v) => expectTypeOf(v).toEqualTypeOf<number>(),
    complete: () => {},
  })
})

test('subscribe shape on fallible Observable receives Result', () => {
  fallible.subscribe((r) => {
    expectTypeOf(r).toEqualTypeOf<Result<number, MyError>>()
    if (r.ok) {
      expectTypeOf(r.value).toEqualTypeOf<number>()
    } else {
      expectTypeOf(r.error).toEqualTypeOf<MyError>()
    }
  })
})

test('Subscriber.next shape mirrors NextArg', () => {
  // non-fallible Subscriber takes the bare value
  expectTypeOf<Parameters<typeof _sub.next>[0]>().toEqualTypeOf<string>()
  // fallible Subscriber takes a Result
  expectTypeOf<Parameters<typeof _fallibleSub.next>[0]>().toEqualTypeOf<Result<string, MyError>>()
})

test('subscribe with no args is allowed', () => {
  const s: Subscription = observable.subscribe()
  expectTypeOf(s.unsubscribe).toBeFunction()
})

test('subscribe with empty observer object is allowed', () => {
  observable.subscribe({})
})

test('filter with a type guard narrows the output', () => {
  const isNumber = (v: unknown): v is number => typeof v === 'number'
  mixed.pipe(filter(isNumber)).subscribe((v) => {
    expectTypeOf(v).toEqualTypeOf<number>()
  })
  observable.pipe(filter((n) => n > 1)).subscribe((v) => {
    expectTypeOf(v).toEqualTypeOf<number>()
  })
})

test('pipe chains beyond six operators keep their types', () => {
  const inc = map((n: number) => n + 1)
  observable.pipe(inc, inc, inc, inc, inc, inc, inc, inc, inc).subscribe((v) => {
    expectTypeOf(v).toEqualTypeOf<number>()
  })
  const op = pipe(inc, inc, inc, inc, inc, inc, inc, inc, inc)
  op(observable).subscribe((v) => {
    expectTypeOf(v).toEqualTypeOf<number>()
  })
  /* Past nine the result is unknown, but the first nine are still checked. */
  observable.pipe(inc, inc, inc, inc, inc, inc, inc, inc, inc, inc).subscribe((v) => {
    expectTypeOf(v).toEqualTypeOf<unknown>()
  })
  const toStr = map((n: number) => `${n}`)
  // @ts-expect-error the third operator receives a string, not a number
  observable.pipe(inc, toStr, inc, inc, inc, inc, inc, inc, inc, inc)
})
