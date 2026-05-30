---
title: observable
description: Push-shaped, composable event streams
---

# observable

```ts twoslash
import {Observable} from 'mikro/observable'
import {filter, finalize, map, take, takeUntil} from 'mikro/observable/operators'
import type {Observer, Subscriber, Subscription} from 'mikro/observable'
```

`Observable<Ok, Err>` is a push-shaped, composable event stream. Native event sources (wifi connection state, ble peripheral lifecycle, UDP datagrams) expose Observables instead of `.on/.off` callbacks. User code can also build its own event sources via `Observable.withEmitters()`.

The shape tracks the [WICG Observable](https://wicg.github.io/observable/) proposal in constructor and operator naming, with two deliberate divergences:

1. **`subscribe()` returns a `Subscription` with `unsubscribe()`** instead of accepting `AbortSignal`.
2. **No error notification channel.** Throws inside observer or operator callbacks are caught at the dispatch boundary and logged, isolated to that subscriber. Recoverable failures that are part of a stream's contract flow as `Result<Ok, Err>` values via `next`.

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

Operators are pure functions — pass them to `pipe()` in order. Custom operators are just `(source: Observable<A>) => Observable<B>`; they compose identically.

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
