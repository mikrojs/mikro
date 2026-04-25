---
title: test
description: On-device test framework with describe, test, and assert
---

# test

```ts twoslash
import {describe, test, assert} from 'mikrojs/test'
```

A lightweight test framework for running tests directly on the device.

## Writing tests

```ts
import {describe, test, assert} from 'mikrojs/test'

describe('math', () => {
  test('addition', () => {
    assert.equal(1 + 1, 2)
  })

  test('async', async () => {
    const result = await someAsyncOperation()
    assert.ok(result)
  })
})
```

Run with [`mikro test`](/cli#mikro-test):

```sh
mikro test
```

## describe(name, fn)

```ts
describe(name: string, fn: () => void): void
```

Group related tests into a suite. Suites can contain tests, `beforeAll`, and `afterAll` hooks. Garbage collection runs between suites to manage heap pressure.

### describe.skip(name, fn)

```ts
describe.skip(name: string, fn: () => void): void
```

Skip all tests in a suite. They will be reported as skipped in the results.

### describe.only(name, fn)

```ts
describe.only(name: string, fn: () => void): void
```

Focus a suite. When any `.only` is present in a file, all non-`.only` suites and tests **in that file** are skipped. Focus is per-file only; other test files in the same `mikro test` run still execute normally. Useful for narrowing down a failing suite during debugging.

```ts twoslash
// @noErrors
import {describe, test, assert} from 'mikrojs/test'
// ---cut---
describe.only('the one I care about', () => {
  test('runs', () => {})
})

describe('everything else', () => {
  test('is skipped', () => {})
})
```

### describe.todo(name, fn)

```ts
describe.todo(name: string, fn: () => void): void
```

Mark an entire suite as todo. Every test in it is reported as todo, regardless of individual flags. Useful for sketching out a feature you plan to implement.

```ts twoslash
// @noErrors
import {describe, test, assert} from 'mikrojs/test'
// ---cut---
describe.todo('bluetooth driver', () => {
  test('connects', () => {})
  test('disconnects', () => {})
})
```

### describe.fixme(name, fn)

```ts
describe.fixme(name: string, fn: () => void): void
```

Same as `describe.skip` but signals that the suite is broken and needs to be fixed. Reported as skipped.

### describe.skipIf(condition)

```ts
describe.skipIf(condition: unknown): (name: string, fn: () => void) => void
```

Skip the suite when `condition` is truthy.

```ts twoslash
// @noErrors
import {describe, test, assert} from 'mikrojs/test'
// ---cut---
describe.skipIf(env.get('MIKRO_ENV') === 'test')('prod only', () => {
  test('production check', () => {
    /* ... */
  })
})
```

### describe.runIf(condition)

```ts
describe.runIf(condition: unknown): (name: string, fn: () => void) => void
```

Only run the suite when `condition` is truthy. This is the inverse of `skipIf`.

```ts twoslash
// @noErrors
import {describe, test, assert} from 'mikrojs/test'
import {env} from 'mikrojs/env'
// ---cut---
const hasWifi = env.get('WIFI_SSID') && env.get('WIFI_PASSPHRASE')

describe.runIf(hasWifi)('wifi', () => {
  test('connect', async () => {
    /* ... */
  })
})
```

## test(name, fn)

```ts
test(name: string, fn: () => void | Promise<void>): void
```

Define a test. The function can be sync or async. Each test has a 10 second timeout.

### test.skip(name, fn)

```ts
test.skip(name: string, fn: () => void | Promise<void>): void
```

Skip a test. It will be reported as skipped in the results.

```ts twoslash
// @noErrors
import {describe, test, assert} from 'mikrojs/test'
// ---cut---
describe('feature', () => {
  test.skip('not ready yet', () => {
    // this won't run
  })
})
```

### test.only(name, fn)

```ts
test.only(name: string, fn: () => void | Promise<void>): void
```

Focus a single test. When any `.only` is present in a file, all non-`.only` tests **in that file** are skipped. Within a suite, if some tests are `.only` and others are not, only the `.only` tests run. Focus is per-file only; other test files in the same `mikro test` run still execute normally. Pass a path pattern to `mikro test` to narrow the run itself.

```ts twoslash
// @noErrors
import {describe, test, assert} from 'mikrojs/test'
// ---cut---
describe('math', () => {
  test.only('this one', () => {
    assert.equal(1 + 1, 2)
  })
  test('others are skipped', () => {})
})
```

### test.fixme(name, fn)

```ts
test.fixme(name: string, fn: () => void | Promise<void>): void
```

Same as `test.skip` but signals that the test is broken and needs to be fixed. Reported as skipped.

### test.skipIf(condition)

```ts
test.skipIf(condition: unknown): (name: string, fn: () => void | Promise<void>) => void
```

Skip the test when `condition` is truthy.

```ts twoslash
// @noErrors
import {describe, test, assert} from 'mikrojs/test'
// ---cut---
describe('feature', () => {
  test.skipIf(env.get('MIKRO_ENV') === 'test')('prod only', () => {
    // skipped during test runs
  })
})
```

### test.runIf(condition)

```ts
test.runIf(condition: unknown): (name: string, fn: () => void | Promise<void>) => void
```

Only run the test when `condition` is truthy. This is the inverse of `skipIf`.

```ts twoslash
// @noErrors
import {describe, test, assert} from 'mikrojs/test'
import {env} from 'mikrojs/env'
// ---cut---
describe('hardware', () => {
  test.runIf(env.get('HAS_SENSOR'))('read sensor', () => {
    // only runs when HAS_SENSOR is set
  })
})
```

### test.todo(name)

```ts
test.todo(name: string): void
```

Register a placeholder test with no function body. Todo tests are not executed and show in blue in the output.

```ts twoslash
// @noErrors
import {describe, test} from 'mikrojs/test'
// ---cut---
describe('feature', () => {
  test.todo('handle reconnect after deep sleep')
})
```

### test.each(cases)

```ts
test.each<T>(cases: T[]): (name: string, fn: (value: T, index: number) => void | Promise<void>) => void
```

Run a test once for each case. Name interpolation: `%s` (string), `%#` (index), `%o` (JSON).

```ts twoslash
// @noErrors
import {describe, test, assert} from 'mikrojs/test'
// ---cut---
describe('math', () => {
  test.each([1, 4, 9])('sqrt of %s', (n) => {
    assert.equal(Math.sqrt(n) % 1, 0)
  })
})
```

Also available on `describe`:

```ts twoslash
// @noErrors
import {describe, test, assert} from 'mikrojs/test'
// ---cut---
describe.each([9600, 115200])('uart at %s baud', (baud) => {
  test('sends data', () => {
    /* ... */
  })
})
```

Composes with `skipIf` and `runIf`:

```ts
test.skipIf(isCI).each([1, 2, 3])('hardware pin %s', (pin) => {
  /* ... */
})
```

## beforeAll(fn) / afterAll(fn)

```ts
beforeAll(fn: () => void | Promise<void>): void
afterAll(fn: () => void | Promise<void>): void
```

Run setup/teardown once per suite. If `beforeAll` throws, all tests in the suite are skipped. `afterAll` errors are non-fatal.

```ts twoslash
// @noErrors
import {describe, test, assert, beforeAll, afterAll} from 'mikrojs/test'
import {nvsStorage} from 'mikrojs/kv/nvs'
// ---cut---
describe('storage', () => {
  afterAll(() => {
    nvsStorage.clear()
  })

  test('write and read', () => {
    const val = nvsStorage.createValue('key')
    val.set('hello')
    assert.equal(val.get(), 'hello')
  })
})
```

## beforeEach(fn) / afterEach(fn)

```ts
beforeEach(fn: () => void | Promise<void>): void
afterEach(fn: () => void | Promise<void>): void
```

Run setup/teardown before and after each test. `beforeEach` runs inside the test timeout; if it throws, the test fails. `afterEach` always runs, even if the test failed; errors are non-fatal.

```ts twoslash
// @noErrors
import {describe, test, assert, beforeEach, afterEach} from 'mikrojs/test'
import {nvsStorage} from 'mikrojs/kv/nvs'
// ---cut---
describe('storage', () => {
  afterEach(() => {
    nvsStorage.delete('test-key')
  })

  test('write', () => {
    nvsStorage.createValue('test-key').set('hello')
  })

  test('independent read', () => {
    assert.equal(nvsStorage.createValue('test-key').get(), undefined)
  })
})
```

## assert

### assert.equal(actual, expected)

Strict equality using `Object.is`.

```ts twoslash
// @noErrors
import {assert} from 'mikrojs/test'
// ---cut---
assert.equal(1 + 1, 2)
assert.equal('hello', 'hello')
```

### assert.notEqual(actual, unexpected)

Strict inequality.

### assert.truthy(value, message?)

Assert value is truthy.

```ts twoslash
// @noErrors
import {assert} from 'mikrojs/test'
// ---cut---
assert.truthy(true)
assert.truthy('non-empty string')
assert.truthy(1 > 0, 'expected positive')
```

### assert.deepEqual(actual, expected)

Deep equality via `JSON.stringify` comparison.

```ts twoslash
// @noErrors
import {assert} from 'mikrojs/test'
// ---cut---
assert.deepEqual({a: 1, b: 2}, {a: 1, b: 2})
assert.deepEqual([1, 2, 3], [1, 2, 3])
```

### assert.throws(fn, message?)

Assert that a function throws. Returns the caught error.

```ts twoslash
// @noErrors
import {assert} from 'mikrojs/test'
// ---cut---
const err = assert.throws(() => {
  throw new Error('boom')
})
assert.equal(err.message, 'boom')
```

### assert.rejects(fn, message?)

Assert that an async function rejects. Returns the caught error.

```ts twoslash
// @noErrors
import {assert} from 'mikrojs/test'
// ---cut---
const err = await assert.rejects(async () => {
  throw new Error('async boom')
})
```

### assert.type(value, expected)

Assert `typeof value === expected`.

```ts twoslash
// @noErrors
import {assert} from 'mikrojs/test'
// ---cut---
assert.type('hello', 'string')
assert.type(42, 'number')
assert.type(true, 'boolean')
```

### assert.instance(value, constructor)

Assert `value instanceof constructor`.

### assert.ok(result)

Assert a `Result` is `ok`. Narrows `result` to `OkResult`, so `result.value` is typed and accessible afterwards.

```ts twoslash
// @noErrors
import {assert} from 'mikrojs/test'
import {encode} from 'mikrojs/cbor'
// ---cut---
const encoded = encode({temp: 22.5})
assert.ok(encoded)
const bytes = encoded.value // typed as Uint8Array
```

### assert.err(result)

Assert a `Result` is an error. Narrows `result` to `ErrResult`, so `result.error` is typed and accessible afterwards.

## Environment

When running under `mikro test`, the environment variable `MIKRO_ENV` is set to `"test"`. Use this for conditional behavior:

```ts twoslash
// @noErrors
import {env} from 'mikrojs/env'
// ---cut---
if (env.get('MIKRO_ENV') === 'test') {
  // test-specific setup
}
```
