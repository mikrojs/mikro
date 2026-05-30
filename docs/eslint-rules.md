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
pinMode(4, 'OUTPUT')

// Good: error is checked
const result = pinMode(4, 'OUTPUT')
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
  const value = analogRead(34)
} catch (err) {
  console.error(err)
}

// Good
const result = analogRead(34)
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

### `@mikrojs/no-promise-reject` {#no-promise-reject}

**Severity:** error

Flags `Promise.reject()` calls and `reject()` callback invocations. Use `err()` from `mikro/result` instead.

```typescript
// Bad: caller has to try/catch to handle this
async function readSensor(): Promise<number> {
  const result = analogRead(34)
  if (!result.ok) return Promise.reject(new Error('read failed'))
  return result.value
}

// Good: caller sees the error in the return type
async function readSensor(): Promise<Result<number, PinError>> {
  const result = analogRead(34)
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

Flags array literals with holes (e.g., `[1,,3]`) and `delete` on array elements. Use `Array.prototype.splice()` or `filter` instead.
