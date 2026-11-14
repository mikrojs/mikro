---
title: result
description: Result type for typed error handling
---

# result

```ts twoslash
import {ok, err, matchError, safe, tryCall} from 'mikro/result'
import type {Result, OkResult, ErrResult} from 'mikro/result'
```

The `Result` type is how Mikro.js represents operations that can fail. Instead of throwing exceptions, functions return `Result<T, E>` where `T` is the success value and `E` is a typed error.

See the [Error Handling](/error-handling) guide for a full introduction.

## Functions

### ok()

Creates a successful result.

```ts
function ok(): OkResult<void>
function ok<T>(value: T): OkResult<T>
```

```ts twoslash
import {ok} from 'mikro/result'
// ---cut---
const result = ok(42)
result.ok // true
result.value // 42
```

### err()

Creates a failed result.

```ts
function err<E>(error: E): ErrResult<E>
```

```ts twoslash
import {err} from 'mikro/result'
// ---cut---
const result = err({name: 'NotFound' as const})
result.ok // false
result.error // {name: 'NotFound'}
```

### safe()

Calls a standard function that throws on bad input and returns the outcome as a `Result`: `ok(value)`, or `err(error)` with what it threw.

```ts
function safe<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Result<R, Error>
// Spelled out where TypeScript can't infer the arguments on its own:
function safe(
  fn: RegExpConstructor,
  pattern: string | RegExp,
  flags?: string,
): Result<RegExp, Error>
function safe(
  fn: typeof JSON.parse,
  text: string,
  reviver?: (key: string, value: any) => any,
): Result<unknown, Error>
function safe(
  fn: typeof JSON.stringify,
  value: unknown,
  replacer?: (key: string, value: any) => any,
  space?: string | number,
): Result<string, Error>
```

```ts twoslash
import {safe} from 'mikro/result'
declare const text: string
// ---cut---
const config = safe(JSON.parse, text)
if (!config.ok) console.error('invalid config:', config.error)
```

`fn` must be one of `JSON.parse`, `JSON.stringify`, `atob`, `btoa`, `decodeURI`, `decodeURIComponent`, `encodeURI`, `encodeURIComponent`, `RegExp` or `String.fromCodePoint`. The errors each one throws are listed under [`no-unsafe-builtins`](/eslint-rules#no-unsafe-builtins). Any other function throws a `TypeError`; use [`tryCall()`](#trycall) for those. It is synchronous.

If a `JSON.parse` reviver or `JSON.stringify` replacer throws, the error is an `Error` with the message `JSON.parse reviver threw` or `JSON.stringify replacer threw`, and what it threw as its `cause`. A bug in the callback is then not mistaken for bad input.

### tryCall()

Calls `fn` and returns the outcome as a `Result`: `ok(value)`, or `err(error)` with what it threw. Use it for code that throws and that `safe()` doesn't cover, such as a function from a library.

```ts
function tryCall<T>(promise: Promise<T>): Promise<Result<T, unknown>>
function tryCall<T>(fn: () => Promise<T>): Promise<Result<T, unknown>>
function tryCall<T>(fn: () => T): Result<T, unknown>
```

```ts twoslash
import {tryCall} from 'mikro/result'
declare const yaml: {parse(text: string): unknown}
declare const lib: {download(url: string): Promise<Uint8Array>}
declare const text: string
declare const url: string
// ---cut---
const doc = tryCall(() => yaml.parse(text))
if (!doc.ok) console.error('invalid config:', doc.error)

const body = await tryCall(() => lib.download(url))
if (!body.ok) console.error('download failed:', body.error)
```

Given a promise, or a `fn` that returns one, `tryCall` returns a promise of a `Result` that never rejects. Passing the promise directly, as in `tryCall(lib.download(url))`, misses a throw that happens before the promise exists; the callback form catches both.

The error is `unknown`, since a library can throw anything, not only an `Error`. Keep the callback short: a bug in your own code inside it comes back as an `Err` instead of a panic with a stack trace.

### matchError()

Exhaustive dispatch on a tagged error's `name` field. The handler map must cover every variant or TypeScript fails the call site at compile time.

```ts
function matchError<E extends {name: string}, R>(
  error: E,
  handlers: {[K in E['name']]: (error: Extract<E, {name: K}>) => R},
): R
```

```ts twoslash
type SensorError = {name: 'ReadFailed'; message: string} | {name: 'NotConnected'}
// ---cut---
import {matchError} from 'mikro/result'

declare const e: SensorError
const summary = matchError(e, {
  ReadFailed: (e) => `read failed: ${e.message}`,
  NotConnected: () => 'sensor not connected',
})
```

## Defining a typed error union

Mikro.js modules expose their failures as tagged unions on `name`. The recommended pattern is a const factory object plus a `ReturnType` extraction:

```ts twoslash
const SensorError = {
  ReadFailed: (message: string) => ({name: 'ReadFailed', message}) as const,
  NotConnected: () => ({name: 'NotConnected'}) as const,
}
type SensorError = ReturnType<(typeof SensorError)[keyof typeof SensorError]>

// Usage: `err(SensorError.ReadFailed('timeout'))` yields
// ErrResult<{name: 'ReadFailed'; message: string}>
```

The factory is plain JS — no runtime indirection, no closure overhead beyond the variant functions themselves. Inline `err({name: 'X' as const, ...})` literals are fine too when a variant only has one or two call sites.

## Result methods

Both `OkResult` and `ErrResult` share the same method interface. The behavior depends on whether the result is Ok or Err.

### .ok

`true` for success, `false` for failure. Use this to narrow the type:

```ts twoslash
// @noErrors
import {DigitalOut} from 'mikro/gpio'
// ---cut---
const result = DigitalOut(20)
if (!result.ok) {
  console.error('DigitalOut failed:', result.error)
  return
}
// result.value is available here
```

### .value / .error

- `OkResult` has `.value: T` and no `.error`
- `ErrResult` has `.error: E` and no `.value`

### .map(fn)

Transforms the success value, leaving errors untouched.

```ts twoslash
import {ok, err} from 'mikro/result'
// ---cut---
const doubled = ok(21).map((v) => v * 2) // OkResult<number>, value: 42
const failed = err('oops').map((v) => v * 2) // ErrResult<string>, unchanged
```

### .mapErr(fn)

Transforms the error value, leaving successes untouched.

```ts twoslash
import {err} from 'mikro/result'
// ---cut---
const result = err('oops').mapErr((e) => ({message: e}))
// ErrResult<{message: string}>
```

### .andThen(fn)

Chains a function that itself returns a `Result`. Useful for sequencing operations that can each fail.

```ts twoslash
import {ok} from 'mikro/result'
import {AnalogIn} from 'mikro/gpio'
// ---cut---
const result = ok(2)
  .andThen((gpio) => AnalogIn(gpio))
  .andThen((pot) => pot.readMillivolts())
```

### .match(handlers)

Exhaustive pattern matching on the result.

```ts twoslash
import {AnalogIn} from 'mikro/gpio'
const result = AnalogIn(2).andThen((pot) => pot.read())
// ---cut---
const message = result.match({
  ok: (value) => `Got: ${value}`,
  err: (error) => `Failed: ${error.name}`,
})
```

### .orPanic(message?)

Returns the value if Ok. If Err, it crashes the program with the error as the `cause`, which the crash report prints in full. The message is optional; give one when it adds context the cause does not.

```ts twoslash
import {DigitalOut} from 'mikro/gpio'
// ---cut---
const led = DigitalOut(20).orPanic('Failed to configure LED pin')
```

Use this when failure is truly unrecoverable (for example during setup).

## Types

### Result\<T, E\>

```ts
type Result<T, E> = OkResult<T> | ErrResult<E>
```
