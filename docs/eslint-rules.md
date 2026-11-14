---
title: ESLint Rules
description: Lint rules that enforce Mikro.js conventions
---

# ESLint Rules

Mikro.js ships `@mikrojs/eslint-plugin`, a set of ESLint rules that enforce the [error handling](/error-handling) conventions and catch patterns that don't work well on microcontrollers. The plugin is enabled by default in new projects.

## Setup

Add the recommended config to your `eslint.config.ts`:

```ts
import mikrojs from '@mikrojs/eslint-plugin'

export default [...mikrojs.configs.recommended]
```

This enables all rules below with their default severities.

## Rules

### `@mikrojs/no-unhandled-result` {#no-unhandled-result}

**Severity:** error

Flags `Result` return values that aren't handled. If a function returns `Result<T, E>` or `Promise<Result<T, E>>` and the call expression isn't assigned to a variable or used in an expression, the error is silently lost.

```typescript
// Bad: error is silently ignored
sensor.read()

// Good: error is checked
const result = sensor.read()
if (!result.ok) return result
```

### `@mikrojs/no-throw` {#no-throw}

**Severity:** error

Flags `throw` statements. Expected errors should be returned as `Result` types. For truly unrecoverable situations, use `panic()` from `mikro/sys`.

```typescript
// Bad
throw new Error('sensor failed')

// Good
return err(SensorError.ReadFailed('sensor failed'))

// Good (for unrecoverable situations)
panic('sensor hardware is missing')
```

### `@mikrojs/no-try-catch` {#no-try-catch}

**Severity:** error

Flags `try/catch` blocks. Since Mikro.js functions return `Result` types, `try/catch` shouldn't be needed. `try/finally` for cleanup is allowed.

```typescript
// Bad
try {
  const value = sensor.read()
} catch (err) {
  console.error(err)
}

// Good
const result = sensor.read()
if (!result.ok) {
  console.error(result.error)
}

// Allowed (try/finally for cleanup)
try {
  doSomething()
} finally {
  cleanup()
}
```

Some standard JavaScript functions throw on bad input, such as `JSON.parse()` on invalid JSON. Call them through `safe()` instead of catching; see [`no-unsafe-builtins`](#no-unsafe-builtins).

For other code that throws, such as a library or a native module function, use [`tryCall()`](/api/result#trycall), which returns the outcome as a `Result`.

### `@mikrojs/no-unsafe-builtins` {#no-unsafe-builtins}

**Severity:** error

Flags direct calls to standard functions that throw on bad input. Call them through [`safe()`](/api/result#safe) from `mikro/result`, which returns the outcome as a `Result`. The editor offers a fix that rewrites the call.

| Function                          | Throws        | When                                           |
| --------------------------------- | ------------- | ---------------------------------------------- |
| `JSON.parse`                      | `SyntaxError` | invalid JSON                                   |
| `JSON.stringify`                  | `TypeError`   | a circular reference or a BigInt               |
| `atob`                            | `SyntaxError` | malformed base64                               |
| `btoa`                            | `RangeError`  | a character above U+00FF                       |
| `decodeURI`, `decodeURIComponent` | `URIError`    | a malformed `%`-sequence                       |
| `encodeURI`, `encodeURIComponent` | `URIError`    | a lone surrogate                               |
| `RegExp`                          | `SyntaxError` | an invalid pattern or flags                    |
| `String.fromCodePoint`            | `RangeError`  | a negative, fractional or too large code point |

`new RegExp()` with only literal arguments is not flagged, since its author can see whether the pattern is valid. Neither is `JSON.stringify()` of plain data: strings, numbers, booleans, null, and object or array literals of those.

```typescript
// Bad: invalid input throws
const config = JSON.parse(text)

// Good: invalid input is an Err
const config = safe(JSON.parse, text)
if (!config.ok) return err(new Error('invalid config', {cause: config.error}))
```

The rule also flags a `safe()` call whose first argument isn't one of these functions. That throws a `TypeError` at runtime.

### `@mikrojs/no-promise-reject` {#no-promise-reject}

**Severity:** error

Flags `Promise.reject()` calls and `reject()` callback invocations. Use `err()` from `mikro/result` instead.

```typescript
// Bad: caller has to try/catch to handle this
async function readSensor(): Promise<number> {
  const result = sensor.read()
  if (!result.ok) return Promise.reject(new Error('read failed'))
  return result.value
}

// Good: caller sees the error in the return type
async function readSensor(): Promise<Result<number, GpioError>> {
  const result = sensor.read()
  if (!result.ok) return result
  return ok(result.value)
}
```

### `@mikrojs/no-dot-catch` {#no-dot-catch}

**Severity:** error

Flags `.catch()` on promises. Async errors should be returned as `Result` types, not caught with `.catch()`.

```typescript
// Bad
fetchData().catch((err) => console.error(err))

// Good
const result = await fetchData()
if (!result.ok) console.error(result.error)
```

A promise that rejects, such as one from a library, becomes a `Result` with [`tryCall()`](/api/result#trycall): `await tryCall(() => lib.download(url))`.

### `@mikrojs/no-eval` {#no-eval}

**Severity:** error

Flags `eval()` calls and `new Function()` expressions. Runtime compilation is expensive on constrained devices and poses security risks.

### `@mikrojs/no-intl` {#no-intl}

**Severity:** error

Flags access to the `Intl` API. The Intl API is not available in QuickJS-NG. Use manual formatting or a lightweight library instead.

### `@mikrojs/no-temporal` {#no-temporal}

**Severity:** error

Flags access to the `Temporal` API. The Temporal API is not available in QuickJS-NG. Use `Date` or a lightweight library instead.

### `@mikrojs/no-sparse-arrays` {#no-sparse-arrays}

**Severity:** warn

Flags array literals with holes (for example `[1,,3]`) and `delete` on array elements. Use `Array.prototype.splice()` or `filter` instead.
