---
title: result
description: Result type for typed error handling
---

# result

```ts twoslash
import {ok, err, defineError} from 'mikrojs/result'
import type {Result, OkResult, ErrResult} from 'mikrojs/result'
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
import {ok} from 'mikrojs/result'
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
import {err} from 'mikrojs/result'
// ---cut---
const result = err({name: 'NotFound' as const})
result.ok // false
result.error // {name: 'NotFound'}
```

### defineError()

Defines a set of named error variants. Each variant is a factory function that produces a tagged error object.

```ts
function defineError<D>(name: string, variants: D): ErrorConstructors<D>
```

```ts twoslash
import {defineError} from 'mikrojs/result'
// ---cut---
const SensorError = defineError('SensorError', {
  ReadFailed: (message: string) => ({message}),
  NotConnected: () => ({}),
})

const e = SensorError.ReadFailed('timeout')
// {name: 'ReadFailed', message: 'timeout'}
```

## Result methods

Both `OkResult` and `ErrResult` share the same method interface. The behavior depends on whether the result is Ok or Err.

### .ok

`true` for success, `false` for failure. Use this to narrow the type:

```ts twoslash
// @noErrors
import {pinMode} from 'mikrojs/pin'
// ---cut---
const result = pinMode(20, 'OUTPUT')
if (!result.ok) {
  console.error(result.error.name)
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
import {ok, err} from 'mikrojs/result'
// ---cut---
const doubled = ok(21).map((v) => v * 2) // OkResult<number>, value: 42
const failed = err('oops').map((v) => v * 2) // ErrResult<string>, unchanged
```

### .mapErr(fn)

Transforms the error value, leaving successes untouched.

```ts twoslash
import {err} from 'mikrojs/result'
// ---cut---
const result = err('oops').mapErr((e) => ({message: e}))
// ErrResult<{message: string}>
```

### .andThen(fn)

Chains a function that itself returns a `Result`. Useful for sequencing operations that can each fail.

```ts twoslash
import {ok} from 'mikrojs/result'
import {pinMode} from 'mikrojs/pin'
// ---cut---
const result = ok(20)
  .andThen((pin) => pinMode(pin, 'OUTPUT'))
  .andThen(() => ok('ready'))
```

### .match(handlers)

Exhaustive pattern matching on the result.

```ts twoslash
import {pinMode} from 'mikrojs/pin'
const result = pinMode(20, 'OUTPUT')
// ---cut---
const message = result.match({
  ok: (value) => `Got: ${value}`,
  err: (error) => `Failed: ${error.name}`,
})
```

### .orPanic(message)

Returns the value if Ok, or crashes the program with the given message if Err. The error is included as the `cause`.

```ts twoslash
import {pinMode} from 'mikrojs/pin'
// ---cut---
const value = pinMode(20, 'OUTPUT').orPanic('Failed to set pin mode')
```

Use this when failure is truly unrecoverable (e.g., during setup).

## Types

### Result\<T, E\>

```ts
type Result<T, E> = OkResult<T> | ErrResult<E>
```

### ErrorOf\<T\>

Utility type that extracts the union of error shapes from an error constructor object (returned by `defineError`).

```ts twoslash
import {defineError} from 'mikrojs/result'
import type {ErrorOf} from 'mikrojs/result'
const SensorError = defineError('SensorError', {
  ReadFailed: (message: string) => ({message}),
  NotConnected: () => ({}),
})
// ---cut---
type MyError = ErrorOf<typeof SensorError>
// {name: 'ReadFailed'; message: string} | {name: 'NotConnected'}
```
