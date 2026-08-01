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

The shape tracks the [WICG Observable](https://wicg.github.io/observable/) proposal in constructor and operator naming, but not in semantics. Three differences to know about:

1. **`subscribe()` returns a `Subscription` with `unsubscribe()`** instead of accepting `AbortSignal`.
2. **No error notification channel.** Throws inside observer or operator callbacks are caught at the dispatch boundary and logged, isolated to that subscriber. Recoverable failures that are part of a stream's contract flow as `Result<Ok, Err>` values via `next`.
3. **Emitting from inside a handler is queued.** The proposal hands each value straight to the next handler, so the call stack grows with every operator in the chain. Here the value is passed on once your handler returns, which is what lets a long chain run on a microcontroller's small stack. Code ported from the proposal or from RxJS behaves the same unless it emits from inside a handler; see [Writing custom operators](#writing-custom-operators).

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
const sub = wifi.onConnect.subscribe((info) => {
  console.log('connected to %s', info.ip)
})

// later, to stop receiving
sub.unsubscribe()
```

`subscribe()` accepts:

- A function: `subscribe((value) => ...)` — sugar for `{next: ...}`
- An object: `subscribe({next, complete})` — both methods optional
- Nothing: `subscribe()` — runs the producer's setup callback for side effects only

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

Operators are pure functions — pass them to `pipe()` in order. Custom operators are just `(source: Observable<A>) => Observable<B>`; they compose identically. If you write one, or emit from inside a handler, read [Writing custom operators](#writing-custom-operators) first: a value you emit is not handed on until your handler returns.

## Operators

Imported from `mikro/observable/operators`. Each is a factory that returns the actual operator function.

### map(fn)

Transform each value through `fn`.

```ts
const map: <A, B>(fn: (value: A) => B) => (source: Observable<A>) => Observable<B>
```

Throws inside `fn` are caught at the dispatch boundary and re-thrown asynchronously (see [Errors](#errors)); the bad value is dropped for that subscription, the subscription stays alive.

### filter(pred)

Pass through values for which `pred(value)` is truthy.

```ts
const filter: <A>(pred: (value: A) => boolean) => (source: Observable<A>) => Observable<A>
```

### take(n)

Emit at most `n` values, then complete. `n <= 0` completes immediately.

```ts
const take: (n: number) => <A>(source: Observable<A>) => Observable<A>
```

### takeUntil(notifier)

Stop emitting (and complete) when `notifier` emits its first value. If `notifier` completes without emitting, the source keeps going.

```ts
const takeUntil: (
  notifier: Observable<unknown, unknown>,
) => <A>(source: Observable<A>) => Observable<A>
```

### finalize(fn)

Run `fn` when the subscription ends — natural completion or `unsubscribe()`. Useful for cleanup that should happen either way.

```ts
const finalize: (fn: () => void) => <A>(source: Observable<A>) => Observable<A>
```

### Writing custom operators

An operator is a function `(source: Observable<A>) => Observable<B>`: subscribe to the source, transform each value, and pass it on with `sub.next(...)`.

`sub.next(value)` does not run the next handler in the chain. It puts the value in a queue and returns; the rest of your handler runs, and only once it returns does the value move on to the handler below. The values you pass on reach that handler in the order you emitted them. This is what keeps a long chain from growing the call stack with every value, and it has three consequences:

- Code you write after `sub.next(value)` runs before the handler below sees that value.
- `sub.closed` right after `sub.next(value)` cannot tell you how the rest of the chain reacted, because none of it has run yet. Keep your own state instead, the way `take` counts how many values it has left.
- Subscribing to something inside a handler is deferred the same way. `Observable.from([7]).subscribe(...)` delivers its values before it returns when you call it normally, but not from inside a handler: there the values arrive after your handler finishes, so reading a variable your callback sets on the next line gives you the old value.

The first one is easy to hit with a reused buffer. This batching operator hands the array on, then empties it, so every batch arrives empty:

```ts twoslash
import {Observable} from 'mikro/observable'
// ---cut---
const batch = (source: Observable<number>): Observable<number[]> =>
  new Observable<number[]>((sub) => {
    const buf: number[] = []
    const upstream = source.subscribe({
      next: (value) => {
        buf.push(value)
        if (buf.length === 4) {
          sub.next(buf) // queued, not delivered yet...
          buf.length = 0 // ...and this empties it before it is
        }
      },
      complete: () => sub.complete(),
    })
    sub.addTeardown(() => upstream.unsubscribe())
  })
```

`sub.next(buf.splice(0))` fixes it: the array is finished before it goes anywhere.

Emitting last, after the rest of your handler's work, avoids all three. Every built-in operator is written that way:

```ts twoslash
import {Observable} from 'mikro/observable'
// ---cut---
const double = (source: Observable<number>): Observable<number> =>
  new Observable<number>((sub) => {
    const upstream = source.subscribe({
      next: (value) => sub.next(value * 2),
      complete: () => sub.complete(),
    })
    sub.addTeardown(() => upstream.unsubscribe())
  })
```

## Building your own Observable

### `new Observable(callback)`

The callback runs once per subscriber. Push values via `subscriber.next(...)`, signal end-of-stream with `subscriber.complete()`, register cleanup with `subscriber.addTeardown(...)`.

```ts twoslash
import {Observable} from 'mikro/observable'
// ---cut---
const ticks = new Observable<number>((subscriber) => {
  let i = 0
  const id = setInterval(() => subscriber.next(i++), 1000)
  subscriber.addTeardown(() => clearInterval(id))
})

const sub = ticks.subscribe((n) => console.log('tick %d', n))
// ... later
sub.unsubscribe() // fires the teardown, clears the interval
```

The constructor produces a **cold** Observable — every subscriber re-runs the callback and gets its own state. For a multicast source, use `withEmitters()`.

### `Observable.withEmitters()`

Returns `{observable, next, complete}`. The `observable` is shared by all subscribers; `next(value)` fans the value out to every active subscriber.

```ts twoslash
import {Observable} from 'mikro/observable'
// ---cut---
const events = Observable.withEmitters<{type: string; data: unknown}>()

events.observable.subscribe((e) => console.log('A:', e))
events.observable.subscribe((e) => console.log('B:', e))

events.next({type: 'ping', data: 1}) // both A and B see this
events.complete() // closes the stream; future subscribers receive immediate complete
```

The naming mirrors `Promise.withResolvers()` — the factory returns the public surface alongside the producer-side handles.

Late subscribers after `complete()` receive an immediate completion. Calling `next()` after `complete()` is a silent no-op.

### `Observable.from(source)`

Convert an iterable, promise, or other Observable into an `Observable`.

```ts twoslash
import {Observable} from 'mikro/observable'
// ---cut---
Observable.from([1, 2, 3]).subscribe((v) => console.log(v))
// 1, 2, 3 emitted synchronously, then complete

Observable.from(Promise.resolve('hi')).subscribe((v) => console.log(v))
// 'hi' emitted on the next microtask, then complete
```

Async iterables are not currently supported.

## Errors

There is no `error` notification channel. Two cases:

**Throws inside observer, operator, or teardown callbacks** are caught at the dispatch boundary, isolated to the offending subscriber, and re-thrown asynchronously via `setTimeout(0)`. The synchronous producer keeps running — sibling subscribers receive the value, remaining teardowns run — and the bug eventually surfaces as an uncaught exception. On device, that uncaught throw halts the runtime via the existing unhandled-rejection path. **Stream errors are panics**, just deferred until after the current dispatch finishes so they don't take down innocent subscribers along the way.

**Failures that are part of a stream's contract** (e.g. an HTTP fetch that may fail) flow as `Result.err(...)` values through `next()`, just like a successful value:

```ts twoslash
import {Observable} from 'mikro/observable'
import type {Result} from 'mikro/result'
declare const httpStream: () => Observable<Result<Uint8Array, {name: 'NetworkError'}>>
// ---cut---
httpStream().subscribe((r) => {
  if (r.ok) handleChunk(r.value)
  else handleError(r.error)
})
declare function handleChunk(chunk: Uint8Array): void
declare function handleError(err: {name: 'NetworkError'}): void
```

## Lifecycle

- `subscribe()` returns a `Subscription` with one method: `unsubscribe()`.
- `unsubscribe()` is idempotent. Subsequent calls are no-ops.
- `unsubscribe()` is silent — it does **not** call `observer.complete()`. Only natural producer-driven completion fires `complete()`.
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
