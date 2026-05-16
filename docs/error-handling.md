---
title: Error Handling
description: How Mikro.js uses typed Results instead of exceptions
---

# Error Handling in Mikro.js

Mikro.js uses typed results instead of exceptions. If you're coming from a `try`/`catch` background, this guide explains why and how to work with them.

## The problem with try/catch

Consider reading a sensor value:

```ts twoslash
// @noErrors
declare function analogRead(pin: number): number
// ---cut---
// Hypothetical API that throws on failure (NOT how Mikro.js works)
const value = analogRead(34)
console.log(`Sensor: ${value}`)
```

This compiles without any warnings. TypeScript says `analogRead` returns `number`, so `value` is `number`. But at runtime, this can crash your program. If pin 34 isn't a valid ADC pin, the function throws. Nothing in the type signature tells you this can happen. You have to _know_ to add error handling.

You might wrap it in try/catch:

```ts twoslash
// @noErrors
declare function analogRead(pin: number): number
// ---cut---
try {
  const value = analogRead(34)
  console.log(`Sensor: ${value}`)
} catch (err) {
  //      ^?
  //
  //
  console.error('Something went wrong: %s', err)
}
```

`err` is `unknown`. Is it a string? An `Error`? Does it have a `.message`? A `.code`? You end up writing `if (err instanceof Error)` checks, guessing at property names, or just logging and hoping for the best.

And this uncertainty is **contagious**. Any function that calls `analogRead` might also throw, but there's no way to know from its signature. You either wrap everything in try/catch defensively, or you don't and hope for the best. Neither option is good.

## How Mikro.js handles errors

Every Mikro.js function that can fail returns a [`Result`](/api/result):

```ts twoslash
import {analogRead} from 'mikrojs/pin'

const result = analogRead(34)
//    ^?
//
//
if (result.ok) {
  console.log(`Sensor: ${result.value}`)
} else {
  switch (result.error.name) {
    //                 ^?
    //
    //
    //
    case 'InvalidAdcPin':
      console.error('Pin 34 is not a valid ADC pin')
      break
    case 'AdcInitFailed':
      console.error('ADC hardware failed: %s', result.error.message)
      break
    default:
      console.error('Read failed: %s', result.error.name)
  }
}
```

The key differences:

- **The type signature is honest.** `analogRead` returns `Result<number, PinError>`; you can see it might fail.
- **The error is typed.** `PinError` is a union of specific variants. TypeScript tells you exactly which errors are possible and what data each one carries.
- **No try/catch needed.** Errors are values you check, not exceptions you catch.

## The Result type

A `Result<T, E>` is either an `Ok` holding a value of type `T`, or an `Err` holding an error of type `E`:

```ts twoslash
import {ok, err} from 'mikrojs/result'

const success = ok(42)
//    ^?
//
//
const failure = err('oops')
//    ^?
//
//
```

### Early returns

The most common pattern is checking and returning early:

```ts twoslash
import {ok, err, type Result} from 'mikrojs/result'
import {analogRead, type PinError} from 'mikrojs/pin'
declare const PublishError: {
  NetworkError: (message: string) => {name: 'NetworkError'; message: string}
}
declare type PublishError = {name: 'NetworkError'; message: string}
declare function publish(value: number): Promise<Result<void, PublishError>>
// ---cut---
async function readAndPublish(pin: number) {
  const reading = analogRead(pin)
  if (!reading.ok) return reading

  const published = await publish(reading.value)
  if (!published.ok) return published

  return ok()
}
```

This is the equivalent of Rust's `?` operator, just spelled out. Notice how TypeScript infers a return type equivalent to `Result<void, PinError | PublishError>`, capturing every way the function can fail. Each early return propagates its own error type, and the caller sees exactly which errors are possible.

If `publish` were to throw instead, that would be a panic: an unexpected bug, not a recoverable error. See [What about exceptions?](#what-about-exceptions) below.

### Transforming values

Use `.map()` to transform the success value without unwrapping:

```ts twoslash
import {analogReadMillivolts} from 'mikrojs/pin'
// ---cut---
const voltage = analogReadMillivolts(34).map((mv) => mv / 1000)
```

Use `.andThen()` to chain operations that themselves return Results:

```ts twoslash
import {pinMode, digitalWrite} from 'mikrojs/pin'
// ---cut---
const result = pinMode(4, 'OUTPUT').andThen(() => digitalWrite(4, 1))
```

### Converting to panics

When failure is unrecoverable and you want to crash explicitly, use `.orPanic()`:

```ts twoslash
import {analogRead} from 'mikrojs/pin'
// ---cut---
const value = analogRead(34).orPanic('ADC must work at this point')
```

This is the equivalent of Rust's `.expect()`. Use it sparingly, only when you've decided that failure at this point means the program cannot continue.

### Exhaustive matching

Use `.match()` to handle both cases:

```ts twoslash
import {analogRead} from 'mikrojs/pin'
// ---cut---
const message = analogRead(34).match({
  ok: (value) => `Reading: ${value}`,
  err: (error) => `Failed: ${error.name}`,
})
```

## Defining errors

Mikro.js modules define their errors as tagged unions, keyed on `name`. The recommended shape is a const factory object plus a `ReturnType` extraction:

```ts twoslash
const SensorError = {
  NotConnected: () => ({name: 'NotConnected'}) as const,
  ReadFailed: (message: string) => ({name: 'ReadFailed', message}) as const,
  OutOfRange: (value: number, min: number, max: number) =>
    ({name: 'OutOfRange', value, min, max}) as const,
}

type SensorError = ReturnType<(typeof SensorError)[keyof typeof SensorError]>
```

This gives you:

- **Constructor functions:** `SensorError.ReadFailed("timeout")` creates `{name: "ReadFailed", message: "timeout"}`
- **A union type:** `SensorError` is `{name: "NotConnected"} | {name: "ReadFailed", message: string} | {name: "OutOfRange", value: number, min: number, max: number}`
- **Exhaustive switching:** TypeScript enforces that you handle every variant in a `switch` block, or via [`matchError`](/api/result#matcherror)

Errors are plain objects; no class hierarchies, no prototypes. They're cheap to create and easy to log over serial.

For variants with only one or two call sites, an inline `err({name: 'X' as const, ...})` literal is fine — the factory pattern is just discoverability over the same shape.

## What about exceptions?

Exceptions still exist in Mikro.js, but they're treated as **panics**: unrecoverable bugs, not expected error conditions.

The distinction:

|                  | Result errors                                | Exceptions (panics)                                |
| ---------------- | -------------------------------------------- | -------------------------------------------------- |
| **When**         | Expected failures (bad pin, network timeout) | Bugs (null dereference, out of memory)             |
| **Typed?**       | Yes, visible in function signature           | No, `unknown`                                      |
| **Handle?**      | Yes, check `result.ok`                       | No, let it crash and read the stack trace          |
| **Stack trace?** | No, you know what failed from the type       | Yes, you need it because the failure is unexpected |

If you see an exception in Mikro.js, it means something is broken, not that a sensor read failed.

Note that some standard JavaScript functions can still throw, such as `JSON.parse()` with invalid input, `atob()` with a malformed string, or `decodeURIComponent()` with invalid sequences. These are not Mikro.js APIs, so they follow standard JavaScript behavior. Use `try`/`catch` around these if the input is untrusted.

When you need to intentionally crash (e.g. missing required configuration), use `env.require` from [`mikrojs/env`](/api/env) or `panic` from [`mikrojs/sys`](/api/sys):

```ts
import {env} from 'mikrojs/env'

// env.require() panics with a clear message if the variable is not set
const ssid = env.require('WIFI_SSID')
```

The runtime always restarts the device on an uncaught exception so deployed apps can self-heal. Tune `panicRestartDelay` (the grace window between the exception and the actual reboot) to match your environment — longer for friendlier dev iteration, shorter for faster convergence in the field:

```ts twoslash
import {defineConfig} from 'mikrojs'

export default defineConfig({
  panicRestartDelay: 500,
})
```

This is the right response to a panic: restart and try again. Result errors, on the other hand, are handled in your code and never trigger a restart.

## Lint rules

Mikro.js includes an [ESLint plugin](/eslint-rules) that enforces these conventions. For example, the [`no-unhandled-result`](/eslint-rules#no-unhandled-result) rule warns you when a `Result` is ignored:

```ts
pinMode(4, 'OUTPUT')
// error: Result must be handled (@mikrojs/no-unhandled-result)
```

Other rules flag `throw`, `try/catch`, `Promise.reject()`, and `.catch()` to keep error handling consistent. See [ESLint Rules](/eslint-rules) for the full list.

## Quick reference

```ts
import {ok, err, matchError, type Result} from 'mikrojs/result'

// Check a result
if (result.ok) {
  result.value // the success value
} else {
  result.error // the typed error
}

// Early return on error
const result = analogRead(pin)
if (!result.ok) return result

// Transform success
result.map((value) => value * 2)

// Chain fallible operations
result.andThen((value) => anotherOperation(value))

// Handle both cases
result.match({
  ok: (value) => {
    /*…*/
  },
  err: (error) => {
    /*…*/
  },
})

// Get value or crash
const value = result.orPanic('must succeed here')

// Switch on error variant
switch (result.error.name) {
  case 'InvalidAdcPin': {
    /*…*/
  }
  case 'AdcInitFailed': {
    /*…*/
  }
}

// Define custom errors
const MyError = {
  NotFound: (id: string) => ({name: 'NotFound', id}) as const,
  Timeout: (ms: number) => ({name: 'Timeout', ms}) as const,
}
type MyError = ReturnType<(typeof MyError)[keyof typeof MyError]>

// Use in function signatures
function myFunction(): Result<string, MyError> {
  if (somethingWrong) return err(MyError.Timeout(5000))
  return ok('done')
}
```
