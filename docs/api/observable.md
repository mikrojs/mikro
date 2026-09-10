---
title: observable
description: Push-based, composable event streams
---

# observable

```ts twoslash
import {Observable, firstValueFrom, from, of, state} from 'mikro/observable'
import {
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  filter,
  finalize,
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
import type {Observer, Subscriber, Subscription} from 'mikro/observable'
```

`Observable<Ok, Err>` is a push-based, composable event stream. Native event sources (wifi connection state, ble peripheral lifecycle, UDP datagrams) expose Observables instead of `.on/.off` callbacks. User code can also build its own event sources via `Observable.withEmitters()`.

The implementation tracks the [WICG Observable](https://wicg.github.io/observable/) proposal in constructor and operator naming, but not in semantics. Five differences to know about:

1. **`subscribe()` returns a `Subscription` with `unsubscribe()`** instead of accepting `AbortSignal`.
2. **No error notification channel.** A throw inside an observer or operator callback panics, like any other uncaught error. Failures that are part of a stream's contract travel as `Result<Ok, Err>` values through `next` instead.
3. **Emitting from inside a handler is queued.** WICG Observable hands each value straight to the next handler, so the call stack grows with every operator in the chain. Here the value is passed on once your handler returns, which is what lets a long chain run on a microcontroller's small stack. Code ported from WICG Observable or from RxJS behaves the same unless it emits from inside a handler; see [Writing custom operators](#writing-custom-operators).
4. **The subscribe callback may return a teardown function.** WICG Observable ignores the callback's return value and only knows `subscriber.addTeardown()`. Here a returned function is registered as a teardown too, as in RxJS; see [`new Observable(callback)`](#new-observable-callback).
5. **Creation helpers are functions, not statics.** `from(source)` and `of(...values)` are named exports of `mikro/observable`, and `from` takes a promise or an iterable, not another Observable. Operators are likewise functions for `pipe()` rather than methods on the class: a method costs RAM in every runtime whether the app uses it or not, and a function composes the same way whether it ships with the runtime or you wrote it.

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

A throw inside `fn` panics (see [Errors](#errors)).

### filter(predicate)

Pass through values for which `predicate(value)` is truthy. A type guard narrows the output type.

```ts
function filter<A, B extends A>(
  predicate: (value: A) => value is B,
): (source: Observable<A>) => Observable<B>
function filter<A>(predicate: (value: A) => boolean): (source: Observable<A>) => Observable<A>
```

### take(count)

Emit at most `count` values, then complete. `count <= 0` completes immediately.

```ts
const take: (count: number) => <A>(source: Observable<A>) => Observable<A>
```

### skip(count)

Drop the first `count` values, then pass the rest through. Useful on a [`state()`](#state-pipeline) value when only changes matter, not the replayed current value.

```ts
const skip: (count: number) => <A>(source: Observable<A>) => Observable<A>
```

### takeUntil(until, options?)

Stop emitting and complete when `until` fires. Given an Observable, that is its first value; if it completes without emitting, the source keeps going. The notifier is subscribed before the source, so one that fires at once ends the stream before the source is subscribed. Given a predicate, that is the first value it accepts, which is delivered before the stream completes unless `inclusive` is `false`.

```ts
function takeUntil(
  notifier: Observable<unknown, unknown>,
): <A>(source: Observable<A>) => Observable<A>
function takeUntil<A>(
  predicate: (value: A) => boolean,
  options?: {inclusive?: boolean},
): (source: Observable<A>) => Observable<A>
```

```ts twoslash
import type {Observable} from 'mikro/observable'
import {takeUntil, timer} from 'mikro/observable/operators'
type Status = 'connecting' | 'connected' | 'disconnected'
declare const status: Observable<Status>
// ---cut---
status.pipe(takeUntil((s) => s === 'disconnected')) // ..., 'disconnected', then complete
status.pipe(takeUntil(timer(10_000))) // whatever arrives in ten seconds, then complete
```

### finalize(fn)

Run `fn` when the subscription ends, whether by natural completion or `unsubscribe()`. Useful for cleanup that should happen either way.

```ts
const finalize: (fn: () => void) => <A>(source: Observable<A>) => Observable<A>
```

### tap(fn)

Run `fn` on each value and pass the value through unchanged. For logging and other side effects; a throw inside `fn` panics.

```ts
const tap: <A>(fn: (value: A) => void) => (source: Observable<A>) => Observable<A>
```

### startWith(value)

Emit `value` on subscribe, then pass the source through.

```ts
const startWith: <A>(value: A) => (source: Observable<A>) => Observable<A>
```

### scan(fn, seed)

Fold values into an accumulator, emitting each intermediate result. `fn` receives the previous accumulator and the new value.

```ts
const scan: <A, B>(fn: (acc: B, value: A) => B, seed: B) => (source: Observable<A>) => Observable<B>
```

### distinctUntilChanged(equals?)

Drop values equal to the previous one. Compares with `===` unless `equals` is given.

```ts
const distinctUntilChanged: <A>(
  equals?: (a: A, b: A) => boolean,
) => (source: Observable<A>) => Observable<A>
```

### mergeWith(...others)

Interleave the source with `others` as they emit. Completes when all of them have completed.

```ts
const mergeWith: <A, B>(...others: Observable<B>[]) => (source: Observable<A>) => Observable<A | B>
```

### withLatestFrom(other)

Pair each source value with the latest value from `other`. Source values that arrive before `other` has emitted are dropped.

```ts
const withLatestFrom: <A, B>(other: Observable<B>) => (source: Observable<A>) => Observable<[A, B]>
```

### switchMap(project)

Map each value to an inner stream and pass on the latest inner stream's values. A new source value unsubscribes the previous inner stream, so only the most recent one is ever live. Completes once the source and the last inner stream have both completed.

The usual shape is "latest request wins": a value selects something to load, and a newer selection makes the older load irrelevant.

```ts twoslash
import {type Observable, from} from 'mikro/observable'
import {debounceTime, distinctUntilChanged, switchMap} from 'mikro/observable/operators'
type Station = {id: number; name: string}
declare const station: Observable<number> // the id the knob points at
declare function fetchStation(id: number): Promise<Station>
// ---cut---
station
  .pipe(
    debounceTime(300),
    distinctUntilChanged(),
    switchMap((id) => from(fetchStation(id))),
  )
  .subscribe((s) => console.log('station %d: %s', s.id, s.name))

// Turn the knob from 3 to 4 while 3 is still loading: the reply for 3 is
// dropped and only 4 is logged. With a `then` on each fetch instead, both
// would log, in whichever order the network returned them.
```

Unsubscribing an inner stream made from a promise drops its result; the request behind it still runs to completion, so on a device the memory it holds is not freed any earlier.

### debounceTime(ms, options?)

Emit a value only once `ms` milliseconds have passed without another one. By default the last value of a burst is emitted when the burst ends (`trailing`); `leading` emits the first value of a burst at once instead of, or as well as, the last. A value still pending when the source completes is emitted first.

```ts
const debounceTime: (
  ms: number,
  options?: {leading?: boolean; trailing?: boolean},
) => <A>(source: Observable<A>) => Observable<A>
```

### throttleTime(ms, options?)

Emit at most one value per `ms` milliseconds. By default the value that opens a window is emitted (`leading`) and the rest of the window is dropped; with `trailing`, the last dropped value is emitted when the window ends, which opens the next window. Use `trailing` when the final position matters, such as pointer moves. A pending trailing value is emitted on complete.

```ts
const throttleTime: (
  ms: number,
  options?: {leading?: boolean; trailing?: boolean},
) => <A>(source: Observable<A>) => Observable<A>
```

### pipe(...operators)

Compose operators left to right into a single operator, without a source. Use it to reuse a chain across streams or to build a [`state()`](#state-pipeline) pipeline. Overloads cover up to nine operators; longer chains compose but come back as `Observable<unknown>`.

```ts twoslash
import {filter, map, pipe} from 'mikro/observable/operators'
// ---cut---
const evenSquares = pipe(
  filter((n: number) => n % 2 === 0),
  map((n) => n * n),
)
```

### timer(delayMs, periodMs?)

Emit `0` after `delayMs` milliseconds and complete. With `periodMs`, keep emitting a rising count every period until unsubscribed.

```ts
function timer(delayMs: number, periodMs?: number): Observable<number>
```

### combineLatest(sources)

Emit a tuple of the latest values of all `sources` whenever any of them emits, once every source has emitted at least once. Completes when all sources have completed, or as soon as one source completes without having emitted, since no tuple can form after that. An empty array emits `[]` and completes.

```ts twoslash
import {Observable} from 'mikro/observable'
import {combineLatest} from 'mikro/observable/operators'
declare const temperature: Observable<number>
declare const unit: Observable<'C' | 'F'>
// ---cut---
combineLatest([temperature, unit]).subscribe(([value, u]) => console.log('%d %s', value, u))
```

### Writing custom operators

An operator is a function with signature `(source: Observable<A>) => Observable<B>`: subscribe to the source, transform each value, and pass it on with `subscriber.next(...)`.

`subscriber.next(value)` does not run the next handler in the chain. It puts the value in a queue and returns; the rest of your handler runs, and only once it returns does the value move on to the handler below. The values you pass on reach that handler in the order you emitted them. This is what keeps a long chain from growing the call stack with every value, and it has three consequences:

- Code you write after `subscriber.next(value)` runs before the handler below sees that value.
- `subscriber.closed` right after `subscriber.next(value)` cannot tell you how the rest of the chain reacted, because none of it has run yet. Keep your own state instead, the way `take` counts how many values it has left.
- Subscribing to something inside a handler is deferred the same way. `from([7]).subscribe(...)` delivers its values before it returns when you call it normally, but not from inside a handler: there the values arrive after your handler finishes, so reading a variable your callback sets on the next line gives you the old value.

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
      complete: () => {
        if (buffer.length > 0) {
          subscriber.next(buffer)
          buffer.length = 0
        }
        subscriber.complete()
      },
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
      complete: () => {
        if (buffer.length > 0) subscriber.next(buffer.splice(0))
        subscriber.complete()
      },
    })
    subscriber.addTeardown(() => upstream.unsubscribe())
  })
```

Emitting last, after the rest of your handler's work, avoids all three. Every built-in operator is written that way.

## Building your own Observable

### `new Observable(callback)`

The callback runs once per subscriber. Push values via `subscriber.next(...)`, signal end-of-stream with `subscriber.complete()`, and return a cleanup function or register one with `subscriber.addTeardown(...)`.

```ts twoslash
import {Observable} from 'mikro/observable'
// ---cut---
const ticks = new Observable<number>((subscriber) => {
  let count = 0
  const id = setInterval(() => subscriber.next(count++), 1000)
  return () => clearInterval(id)
})

const subscription = ticks.subscribe((tick) => console.log('tick %d', tick))
// ... later
subscription.unsubscribe() // fires the teardown, clears the interval
```

A returned function is registered as if it had been passed to `addTeardown` last, so it runs before any teardowns added earlier. Use `addTeardown` when cleanup has to be registered before the callback ends, for example when a value emitted during setup could close the subscriber. Any other return value is ignored.

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

### from(source)

Turn a promise or an iterable into an Observable. An iterable is pulled one element per subscriber, synchronously, and pulling stops if the subscriber unsubscribes, so a generator never runs past what was consumed.

```ts twoslash
import {from} from 'mikro/observable'
// ---cut---
from([1, 2, 3]).subscribe((value) => console.log(value))
// 1, 2, 3 emitted synchronously, then complete

from(Promise.resolve('hi')).subscribe((value) => console.log(value))
// 'hi' emitted on the next microtask, then complete
```

Async iterables are not currently supported.

### of(...values)

Emit the given values in order, then complete. `of([1, 2])` emits the array as one value; `from([1, 2])` emits its elements.

```ts
function of<T>(...values: T[]): Observable<T>
```

### state(pipeline)

A state container. Returns a tuple: the value stream, a function that pushes an input through `pipeline`, and one that completes it. Every subscriber to the value stream receives the current result first, then each new one. The pipeline provides the initial value (`startWith`) and decides what an input means, so one container covers everything from a plain setter to a reducer over actions. Name the stream for what it holds and the sender for what sending does.

A plain value:

```ts twoslash
import {state} from 'mikro/observable'
import {startWith} from 'mikro/observable/operators'
// ---cut---
const [brightness, setBrightness] = state(startWith(128))
brightness.subscribe((b) => console.log('brightness %d', b)) // logs 128 right away
setBrightness(255) // logs 255
```

A value with rules. Inputs pass through the pipeline before they become the value; an input the pipeline drops leaves the current value in place:

```ts twoslash
import {state} from 'mikro/observable'
import {distinctUntilChanged, filter, map, pipe, startWith} from 'mikro/observable/operators'
// ---cut---
const [ssid, setSsid] = state(
  pipe(
    map((s: string) => s.trim()),
    filter((s) => s.length > 0 && s.length <= 32),
    distinctUntilChanged(),
    startWith(''),
  ),
)
setSsid('  lab  ') // value becomes 'lab'
setSsid('') // dropped; value stays 'lab'
```

A value folded from deltas. The input is a change, not the new value:

```ts twoslash
import {state} from 'mikro/observable'
import {pipe, scan, startWith} from 'mikro/observable/operators'
// ---cut---
const [count, add] = state(
  pipe(
    scan((n: number, delta: number) => n + delta, 0),
    startWith(0),
  ),
)
add(1) // 1
add(-2) // -1
```

A value reduced from actions. The input is a union and the pipeline is a reducer:

```ts twoslash
import {state} from 'mikro/observable'
import {pipe, scan, startWith} from 'mikro/observable/operators'
// ---cut---
type Mode = 'heat' | 'cool' | 'off'
type Thermostat = {target: number; current: number; mode: Mode}
type Action = {type: 'target'; value: number} | {type: 'mode'; value: Mode} | {type: 'tick'}

const initial: Thermostat = {target: 21, current: 19.5, mode: 'off'}

function reduce(t: Thermostat, a: Action): Thermostat {
  switch (a.type) {
    case 'target':
      return {...t, target: a.value}
    case 'mode':
      return {...t, mode: a.value}
    case 'tick': {
      const drift = t.mode === 'off' ? -0.05 : Math.sign(t.target - t.current) * 0.1
      return {...t, current: t.current + drift}
    }
  }
}

const [thermostat, dispatch] = state(pipe(scan(reduce, initial), startWith(initial)))
dispatch({type: 'mode', value: 'heat'})
```

A reducer fed by a stream as well as by code. Merge the stream into the input ahead of the reducer, and both arrive at the same `reduce`:

```ts twoslash
import {state} from 'mikro/observable'
import {map, mergeWith, pipe, scan, startWith, timer} from 'mikro/observable/operators'
type Mode = 'heat' | 'cool' | 'off'
type Thermostat = {target: number; current: number; mode: Mode}
type Action = {type: 'target'; value: number} | {type: 'mode'; value: Mode} | {type: 'tick'}
declare const initial: Thermostat
declare function reduce(t: Thermostat, a: Action): Thermostat
// ---cut---
const [thermostat, dispatch] = state<Action, Thermostat>(
  pipe(
    mergeWith(timer(1000, 1000).pipe(map((): Action => ({type: 'tick'})))),
    scan(reduce, initial),
    startWith(initial),
  ),
)
dispatch({type: 'target', value: 22})
```

A value that can be in error, and recover. There is no error channel, so a failed read lands in the value as a typed error like any other outcome, and the next refresh replaces it. `switchMap` drops a stale read when a new refresh arrives first:

```ts twoslash
import {from, state} from 'mikro/observable'
import {pipe, startWith, switchMap} from 'mikro/observable/operators'
import type {Result} from 'mikro/result'
type SensorError = {name: 'SensorTimeoutError'} | {name: 'SensorChecksumError'}
declare function read(): Promise<Result<number, SensorError>>
// ---cut---
type Reading =
  | {status: 'idle'}
  | {status: 'reading'}
  | {status: 'ok'; value: number}
  | {status: 'error'; error: SensorError}

function settle(result: Result<number, SensorError>): Reading {
  return result.ok ? {status: 'ok', value: result.value} : {status: 'error', error: result.error}
}

const [reading, refresh] = state<void, Reading>(
  pipe(
    switchMap(() => from(read().then(settle)).pipe(startWith<Reading>({status: 'reading'}))),
    startWith<Reading>({status: 'idle'}),
  ),
)

reading.subscribe((r) => {
  if (r.status === 'error') console.error('sensor read failed:', r.error)
})
refresh() // reading, then error if the bus times out
refresh() // reading, then ok; the error is gone
```

Derived values are ordinary pipes on the value stream; there is no second container:

```ts twoslash
import type {Observable} from 'mikro/observable'
import {distinctUntilChanged, map} from 'mikro/observable/operators'
type Thermostat = {target: number; current: number; mode: 'heat' | 'cool' | 'off'}
declare const thermostat: Observable<Thermostat>
// ---cut---
const heating = thermostat.pipe(
  map((t) => t.mode === 'heat' && t.current < t.target),
  distinctUntilChanged(),
)
```

Unlike `withEmitters()`, the internal subscription is made when `state()` is called, so values pushed before anyone subscribes are kept. `complete()` stops it: the pipeline is unsubscribed, merged sources included, and the output completes. A completed container ignores writes, whether it completed through `complete()` or through a `take` or `takeUntil` inside the pipeline, as `withEmitters()` does; late subscribers still receive the last value, then complete. A source that keeps writing into a finished container is a timer or subscription that outlived its owner, which the test runner's timer and pending counts report.

### firstValueFrom(source)

Resolve with the first value the source emits, or with `undefined` if it completes without one. The subscription ends as soon as the promise settles. Pair it with [`takeUntil`](#takeuntil-until-options) and [`timer`](#timer-delayms-periodms) for a deadline.

```ts twoslash
import {firstValueFrom} from 'mikro/observable'
import {takeUntil, timer} from 'mikro/observable/operators'
import {wifi} from 'mikro/wifi'
// ---cut---
const info = await firstValueFrom(wifi.onConnect.pipe(takeUntil(timer(10_000))))
if (!info) console.log('no connection within 10 s')
```

## Errors

There is no `error` notification channel. Unexpected throws and failures the stream is meant to report are handled differently.

A throw inside an observer, operator, or teardown callback is an application crash, the same as a throw anywhere else. It is reported with its stack, and the device then does whatever [`onPanic`](/config#onpanic) says: by default it stays awake and reachable for a second, so you can deploy a fix, then restarts.

Nothing else is delivered after that. Values still queued for other subscribers are dropped, a multicast fan-out stops where it is, `from(iterable)` stops pulling, and any further `next()` or `complete()` from the producer does nothing. Teardowns are the exception: the remaining ones still run, because they release handlers and timers for work that is already ending.

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
- If the producer callback throws part way through setup, the teardowns it already registered still run. Nothing else could release them: no `Subscription` is returned, so there is nobody left to unsubscribe.
- A throw inside a teardown panics, but the remaining teardowns still run.

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
