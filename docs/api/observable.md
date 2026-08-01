---
title: observable
description: Push-based, composable event streams
---

# observable

```ts twoslash
import {Observable} from 'mikro/observable'
import {filter, finalize, map, take, takeUntil} from 'mikro/observable/operators'
import type {Observer, Subscriber, Subscription} from 'mikro/observable'
```

`Observable<Ok, Err>` is a push-based, composable event stream. Native event sources (wifi connection state, ble peripheral lifecycle, UDP datagrams) expose Observables instead of `.on/.off` callbacks. User code can also build its own event sources via `Observable.withEmitters()`.

The implementation tracks the [WICG Observable](https://wicg.github.io/observable/) proposal in constructor and operator naming, but not in semantics. Three differences to know about:

1. **`subscribe()` returns a `Subscription` with `unsubscribe()`** instead of accepting `AbortSignal`.
2. **No error notification channel.** Throws inside observer or operator callbacks are caught at the dispatch boundary and logged, isolated to that subscriber. Recoverable failures that are part of a stream's contract flow as `Result<Ok, Err>` values via `next`.
3. **Emitting from inside a handler is queued.** WICG Observable hands each value straight to the next handler, so the call stack grows with every operator in the chain. Here the value is passed on once your handler returns, which is what lets a long chain run on a microcontroller's small stack. Code ported from WICG Observable or from RxJS behaves the same unless it emits from inside a handler; see [Writing custom operators](#writing-custom-operators).

## When to use Observable

| Use Observable                                                 | Use AsyncIterable / pull-based                 |
| -------------------------------------------------------------- | ---------------------------------------------- |
| Discrete events (wifi connect, ble disconnect, gpio interrupt) | Byte streams (UART read, HTTP body, file read) |
| Multi-consumer fan-out                                         | Single-consumer with backpressure              |
| Producer-paced (rate set by hardware/network)                  | Consumer-paced                                 |

If the source is "things happen, here is a record of each happening", that's an Observable. If it's "give me the next chunk of bytes when I'm ready", that's an `AsyncIterable`.

## Subscribing

```ts twoslash
import {wifi} from 'mikro/wifi'
// ---cut---
const subscription = wifi.onConnect.subscribe((info) => {
  console.log('connected to %s', info.ip)
})

// later, to stop receiving
subscription.unsubscribe()
```

`subscribe()` accepts:

- A function: `subscribe((value) => ...)`, shorthand for `{next: ...}`
- An object: `subscribe({next, complete})`, both methods optional
- Nothing: `subscribe()`, which runs the producer's setup callback for its side effects only

## Composing with `pipe()`

```ts twoslash
import {wifi} from 'mikro/wifi'
import {filter, map, take} from 'mikro/observable/operators'
// ---cut---
wifi.onConnect
  .pipe(
    map((info) => info.ip),
    filter((ip) => ip.startsWith('192.168.')),
    take(1),
  )
  .subscribe((ip) => console.log('first LAN IP: %s', ip))
```

Operators are pure functions; pass them to `pipe()` in order. Custom operators are just `(source: Observable<A>) => Observable<B>`; they compose identically. If you write one, or emit from inside a handler, read [Writing custom operators](#writing-custom-operators) first: a value you emit is not handed on until your handler returns.

## Operators

Imported from `mikro/observable/operators`. Each one is a factory that returns the operator function.

### map(fn)

Transform each value through `fn`.

```ts
const map: <A, B>(fn: (value: A) => B) => (source: Observable<A>) => Observable<B>
```

Throws inside `fn` are caught at the dispatch boundary and re-thrown asynchronously (see [Errors](#errors)); the bad value is dropped for that subscription, the subscription stays alive.

### filter(predicate)

Pass through values for which `predicate(value)` is truthy.

```ts
const filter: <A>(predicate: (value: A) => boolean) => (source: Observable<A>) => Observable<A>
```

### take(count)

Emit at most `count` values, then complete. `count <= 0` completes immediately.

```ts
const take: (count: number) => <A>(source: Observable<A>) => Observable<A>
```

### takeUntil(notifier)

Stop emitting (and complete) when `notifier` emits its first value. If `notifier` completes without emitting, the source keeps going.

```ts
const takeUntil: (
  notifier: Observable<unknown, unknown>,
) => <A>(source: Observable<A>) => Observable<A>
```

### finalize(fn)

Run `fn` when the subscription ends, whether by natural completion or `unsubscribe()`. Useful for cleanup that should happen either way.

```ts
const finalize: (fn: () => void) => <A>(source: Observable<A>) => Observable<A>
```

### Writing custom operators

An operator is a function with signature `(source: Observable<A>) => Observable<B>`: subscribe to the source, transform each value, and pass it on with `subscriber.next(...)`.

`subscriber.next(value)` does not run the next handler in the chain. It puts the value in a queue and returns; the rest of your handler runs, and only once it returns does the value move on to the handler below. The values you pass on reach that handler in the order you emitted them. This is what keeps a long chain from growing the call stack with every value, and it has three consequences:

- Code you write after `subscriber.next(value)` runs before the handler below sees that value.
- `subscriber.closed` right after `subscriber.next(value)` cannot tell you how the rest of the chain reacted, because none of it has run yet. Keep your own state instead, the way `take` counts how many values it has left.
- Subscribing to something inside a handler is deferred the same way. `Observable.from([7]).subscribe(...)` delivers its values before it returns when you call it normally, but not from inside a handler: there the values arrive after your handler finishes, so reading a variable your callback sets on the next line gives you the old value.

The first one is easy to hit with a reused buffer. This batching operator hands the array on, then empties it, so every batch arrives empty:

```ts twoslash
import {Observable} from 'mikro/observable'
// ---cut---
const batch = (source: Observable<number>): Observable<number[]> =>
  new Observable<number[]>((subscriber) => {
    const buffer: number[] = []
    const upstream = source.subscribe({
      next: (value) => {
        buffer.push(value)
        if (buffer.length === 4) {
          subscriber.next(buffer) // queued, not delivered yet...
          buffer.length = 0 // ...and this empties it before it is
        }
      },
      complete: () => subscriber.complete(),
    })
    subscriber.addTeardown(() => upstream.unsubscribe())
  })
```

The same operator, with the array finished before it is passed on:

```ts twoslash
import {Observable} from 'mikro/observable'
// ---cut---
const batch = (source: Observable<number>): Observable<number[]> =>
  new Observable<number[]>((subscriber) => {
    const buffer: number[] = []
    const upstream = source.subscribe({
      next: (value) => {
        buffer.push(value)
        if (buffer.length === 4) {
          subscriber.next(buffer.splice(0)) // hands over a finished array
        }
      },
      complete: () => subscriber.complete(),
    })
    subscriber.addTeardown(() => upstream.unsubscribe())
  })
```

Emitting last, after the rest of your handler's work, avoids all three. Every built-in operator is written that way.

## Building your own Observable

### `new Observable(callback)`

The callback runs once per subscriber. Push values via `subscriber.next(...)`, signal end-of-stream with `subscriber.complete()`, register cleanup with `subscriber.addTeardown(...)`.

```ts twoslash
import {Observable} from 'mikro/observable'
// ---cut---
const ticks = new Observable<number>((subscriber) => {
  let count = 0
  const id = setInterval(() => subscriber.next(count++), 1000)
  subscriber.addTeardown(() => clearInterval(id))
})

const subscription = ticks.subscribe((tick) => console.log('tick %d', tick))
// ... later
subscription.unsubscribe() // fires the teardown, clears the interval
```

The constructor produces a **cold** Observable: every subscriber re-runs the callback and gets its own state. For a multicast source, use `withEmitters()`.

### `Observable.withEmitters()`

Returns `{observable, next, complete}`. The `observable` is shared by all subscribers; `next(value)` fans the value out to every active subscriber.

```ts twoslash
import {Observable} from 'mikro/observable'
// ---cut---
const events = Observable.withEmitters<{type: string; data: unknown}>()

events.observable.subscribe((event) => console.log('A:', event))
events.observable.subscribe((event) => console.log('B:', event))

events.next({type: 'ping', data: 1}) // both A and B see this
events.complete() // closes the stream; future subscribers receive immediate complete
```

The naming mirrors `Promise.withResolvers()`: the factory returns the public surface alongside the producer-side handles.

Late subscribers after `complete()` receive an immediate completion. Calling `next()` after `complete()` does nothing.

### `Observable.from(source)`

Convert an iterable, promise, or other Observable into an `Observable`.

```ts twoslash
import {Observable} from 'mikro/observable'
// ---cut---
Observable.from([1, 2, 3]).subscribe((value) => console.log(value))
// 1, 2, 3 emitted synchronously, then complete

Observable.from(Promise.resolve('hi')).subscribe((value) => console.log(value))
// 'hi' emitted on the next microtask, then complete
```

Async iterables are not currently supported.

## Errors

There is no `error` notification channel. Unexpected throws and failures the stream is meant to report are handled differently.

A throw inside an observer, operator, or teardown callback is caught where it happens and kept to that one subscriber: the value is dropped for it, sibling subscribers still receive the value, remaining teardowns still run, and the producer carries on. The error is re-thrown on the next tick with `setTimeout(0)`, so it surfaces as an uncaught error with its stack, exactly like a throw from any other callback in your app: printed, never silently dropped, and your app keeps running. If a failing subscriber should take the app down, that is for your own code to decide.

Failures that are part of a stream's contract, such as an HTTP fetch that may fail, travel as `Result.err(...)` values through `next()`, like any other value:

```ts twoslash
import {Observable} from 'mikro/observable'
import type {Result} from 'mikro/result'
declare const httpStream: () => Observable<Result<Uint8Array, {name: 'NetworkError'}>>
// ---cut---
httpStream().subscribe((result) => {
  if (result.ok) handleChunk(result.value)
  else handleError(result.error)
})
declare function handleChunk(chunk: Uint8Array): void
declare function handleError(err: {name: 'NetworkError'}): void
```

## Lifecycle

- `subscribe()` returns a `Subscription` with one method: `unsubscribe()`.
- `unsubscribe()` is idempotent. Subsequent calls are no-ops.
- `unsubscribe()` is silent: it does **not** call `observer.complete()`. Only natural producer-driven completion fires `complete()`.
- Teardowns registered via `subscriber.addTeardown()` run in reverse insertion order, on both natural completion and `unsubscribe()`.
- Throws inside teardowns are caught and logged so subsequent teardowns still run.

## Types

### Observable\<Ok, Err\>

The second type parameter mirrors `Result<Ok, Err>`. Streams that can't fail use the default `Err = never`; streams that can fail name their error type, and the type system threads `Result<Ok, Err>` through observers.

### Subscription

```ts
interface Subscription {
  unsubscribe(): void
}
```

### Observer\<Ok, Err\>

```ts
type Observer<Ok, Err = never> = {
  next?: (value: NextArg<Ok, Err>) => void
  complete?: () => void
}
```

### Subscriber\<Ok, Err\>

The handle passed to a producer's subscribe callback.

```ts
interface Subscriber<Ok, Err = never> {
  next(value: NextArg<Ok, Err>): void
  complete(): void
  addTeardown(fn: () => void): void
  readonly closed: boolean
}
```
