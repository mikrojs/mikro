import type {Observable, Subscriber, Subscription} from '@mikrojs/native/runtime/observable/types'
import type {Result} from 'mikrojs/result'
import {expectTypeOf, test} from 'vitest'

declare const observable: Observable<number>
declare const fallible: Observable<number, MyError>
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
