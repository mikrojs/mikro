---
title: Testing
description: How to write and run tests for your Mikro.js app
---

# Testing

Mikro.js includes a built-in test framework and a CLI command for running tests directly on the device. Tests run in isolation: each test file is deployed and executed in a fresh runtime with a full heap.

## Quick start

Create a test file:

```ts twoslash
// test/math.test.ts
import {describe, test, assert} from 'mikro/test'

describe('math', () => {
  test('addition', () => {
    assert.equal(1 + 1, 2)
  })
})
```

Run it:

```sh
mikro test
```

The `mikro test` command discovers all `*.test.ts` files, deploys them to the connected device, and reports colored results:

```ansi
[1m[1/1][0m test/math.test.ts
[2m  Building...[0m
[2m  Deploying...[0m
[2m  Waiting for results...[0m
  math
    [32m✓[0m [2maddition[0m [2m(1ms)[0m
  [32m1 passed[0m [2m(12ms)[0m

[32;1mPASS[0m [32m1 passed[0m (1 tests across 1 files) [2m3.2s[0m
```

Failures show in red with the error message indented below. Skipped tests show in yellow.

## Writing tests

Import `describe`, `test`, and `assert` from [`mikro/test`](/api/test).

### Suites and tests

```ts twoslash
import {describe, test, assert} from 'mikro/test'

describe('my module', () => {
  test('sync test', () => {
    assert.equal(2 * 3, 6)
  })

  test('async test', async () => {
    const {sleep} = await import('mikro/sleep')
    const start = Date.now()
    await sleep(50)
    assert.truthy(Date.now() - start >= 40)
  })
})
```

### Skipping tests

```ts twoslash
import {describe, test} from 'mikro/test'
// ---cut---
test.skip('not ready yet', () => {
  // this won't run, but shows as skipped in output
})

describe.skip('entire suite', () => {
  test('also skipped', () => {})
})
```

Use `test.fixme` / `describe.fixme` to flag broken tests that need to be fixed (same behavior as `skip`, different intent).

### Focusing tests

```ts twoslash
import {describe, test} from 'mikro/test'
// ---cut---
test.only('the one I care about', () => {
  // only this test runs; all others in the file are skipped
})

describe.only('focused suite', () => {
  test('runs', () => {})
})
```

When any `.only` is present in a file, non-focused suites and tests in **that file** are skipped. Focus is per-file only, not manifest-wide: other test files in the run still execute normally, since each one evaluates in its own fresh runtime. To narrow the run across files, pass a path or glob:

```sh
# Just the one file
mikro test 'test/math.test.ts'

# Anything under test/wifi/
mikro test 'test/wifi/**/*.test.ts'
```

### Conditional tests

Use `skipIf` and `runIf` to conditionally skip tests or suites based on a truthy/falsy expression:

```ts twoslash
import {describe, test, assert} from 'mikro/test'
import {env} from 'mikro/env'

const hasWifi = env.get('WIFI_SSID') && env.get('WIFI_PASSPHRASE')

// skip the entire suite when credentials are missing
describe.runIf(hasWifi)('wifi', () => {
  test('connect', async () => {
    const {wifi} = await import('mikro/wifi')
    const result = await wifi.connect({
      ssid: env.get('WIFI_SSID')!,
      passphrase: env.get('WIFI_PASSPHRASE')!,
    })
    assert.ok(result)
  })
})
```

These are available on both `test` and `describe`:

| Modifier                   | Behavior                                             |
| -------------------------- | ---------------------------------------------------- |
| `test.skip(name, fn)`      | Always skip                                          |
| `test.only(name, fn)`      | Focus: if any `.only` exists, only focused tests run |
| `test.fixme(name, fn)`     | Skip with intent "broken, needs fix"                 |
| `test.skipIf(cond)`        | Skip when `cond` is truthy                           |
| `test.runIf(cond)`         | Skip when `cond` is falsy                            |
| `describe.skip(name, fn)`  | Skip all tests in the suite                          |
| `describe.only(name, fn)`  | Focus the suite                                      |
| `describe.todo(name, fn)`  | Mark suite as todo; all tests reported as todo       |
| `describe.fixme(name, fn)` | Skip the suite with intent "broken, needs fix"       |
| `describe.skipIf(cond)`    | Skip suite when `cond` is truthy                     |
| `describe.runIf(cond)`     | Skip suite when `cond` is falsy                      |

`skipIf` and `runIf` return a function, so the test/suite name comes in the second call:

```ts twoslash
import {describe, test} from 'mikro/test'
declare const isDev: boolean
declare const hasHardware: boolean
// ---cut---
test.skipIf(isDev)('prod only', () => {})
describe.runIf(hasHardware)('gpio', () => {})
```

### Todo tests

Mark tests you plan to write later. No function body is needed:

```ts twoslash
import {test} from 'mikro/test'
// ---cut---
test.todo('handle reconnect after deep sleep')
test.todo('retry on timeout')
```

Todo tests show as blue in the output and are counted separately from skipped tests.

### Parameterized tests

Use `test.each` or `describe.each` to run the same test with different inputs:

```ts twoslash
import {describe, test} from 'mikro/test'
// ---cut---
test.each([0, 1, 2])('pin %s toggles', (pin) => {
  // runs three tests: "pin 0 toggles", "pin 1 toggles", "pin 2 toggles"
})

describe.each([9600, 115200])('uart at %s baud', (baud) => {
  test('sends data', () => {
    /* ... */
  })
})
```

Name interpolation supports `%s` (string coercion), `%#` (index), and `%o` (JSON for objects).

`each` composes with `skipIf` and `runIf`:

```ts twoslash
import {test} from 'mikro/test'
declare const isCI: boolean
// ---cut---
test.skipIf(isCI).each([1, 2, 3])('hardware test %s', (pin) => {
  /* ... */
})
```

### Setup and teardown

`beforeAll` and `afterAll` run once per suite. `beforeEach` and `afterEach` run around every test:

```ts twoslash
import {describe, test, assert, afterAll, afterEach} from 'mikro/test'
import {nvsStorage} from 'mikro/kv/nvs'

describe('storage', () => {
  const val = nvsStorage.createValue('test-key')

  afterAll(() => {
    nvsStorage.clear().orPanic('nvs clear failed')
  })

  afterEach(() => {
    val.delete()
  })

  test('write and read', () => {
    val.set('hello')
    assert.equal(val.get(), 'hello')
  })
})
```

If `beforeAll` throws, all tests in the suite are skipped. If `beforeEach` throws, that test fails. `afterAll` and `afterEach` errors are non-fatal.

### Assertions

The `assert` object provides common assertion methods:

| Method                         | Description                              |
| ------------------------------ | ---------------------------------------- |
| `assert.equal(a, b)`           | Strict equality (`Object.is`)            |
| `assert.notEqual(a, b)`        | Strict inequality                        |
| `assert.truthy(value)`         | Truthy check                             |
| `assert.deepEqual(a, b)`       | Deep equality (JSON comparison)          |
| `assert.throws(fn)`            | Expects function to throw                |
| `assert.rejects(fn)`           | Expects async function to reject         |
| `assert.type(value, type)`     | `typeof` check                           |
| `assert.instance(value, ctor)` | `instanceof` check                       |
| `assert.ok(result)`            | Asserts `Result` is ok, returns value    |
| `assert.err(result)`           | Asserts `Result` is error, returns error |

See the full [`mikro/test` API reference](/api/test) for details.

### Testing Results

Since Mikro.js APIs return `Result` types, `assert.ok` and `assert.err` are particularly useful:

```ts twoslash
import {describe, test, assert} from 'mikro/test'
import {encode, decode} from 'mikro/cbor'

describe('cbor', () => {
  test('roundtrip', () => {
    const encoded = encode({temp: 22.5})
    assert.ok(encoded)
    const decoded = decode(encoded.value)
    assert.ok(decoded)
    assert.deepEqual(decoded.value, {temp: 22.5})
  })

  test('decode rejects invalid input', () => {
    const result = decode(new Uint8Array([0xff, 0xff]))
    assert.err(result)
    assert.equal(result.error.name, 'DecodeFailed')
  })
})
```

## Running tests

### All tests

```sh
mikro test
```

### Specific file

```sh
mikro test 'test/math.test.ts'
```

### With environment variables

`mikro test` auto-loads `.env` and `.env.test` from the project root. Pass `--env-file FILE` to layer an extra file on top, or `--no-auto-env` to skip auto-discovery. See [Environment Variables](/environment-variables) for the full precedence rules.

The `MIKRO_ENV` variable is automatically set to `"test"` during test runs. Use it for conditional behavior:

```ts twoslash
import {env} from 'mikro/env'

if (env.get('MIKRO_ENV') === 'test') {
  // test-specific setup
}
```

### Environment-based skipping

Tests that depend on hardware or network can use `runIf` with env vars:

```ts twoslash
import {env} from 'mikro/env'
import {describe, test, assert} from 'mikro/test'

const ssid = env.get('WIFI_SSID')
const pass = env.get('WIFI_PASSPHRASE')

describe.runIf(ssid && pass)('wifi', () => {
  test('connect', async () => {
    const {wifi} = await import('mikro/wifi')
    const result = await wifi.connect({ssid: ssid!, passphrase: pass!})
    assert.equal(result.ok, true)
  })
})
```

## Resource tracking

Each test file runs in a fresh runtime with a full heap.

The test runner flags common leaks at the end of each file:

- **Timers** that were started but never cleared.
- **In-flight HTTP requests** that weren't cancelled or awaited.
- **Heap growth** that exceeds a committed per-file baseline.

These show up as `⚠` warnings in the test output.

### Heap-baseline snapshots

The first run writes each file's measured heap delta, keyed by chip, to `<name>.test.heap-baseline.json` next to the test. These should be committed. Subsequent runs compare against the stored value and warn if it's exceeded. When a refactor legitimately changes the footprint, rerun with `--update-heap-baselines` to overwrite the snapshots; the diff lands with the code change.

`beforeAll` warmup (module init, `wifi.connect`, a throwaway TLS handshake) is folded into the baseline automatically.

## Project structure

`mikro test` picks up every `*.test.ts` under the current directory (ignoring `node_modules/` and `build/`):

```
app/
  sensors/
    temperature.ts
    temperature.test.ts
  storage/
    kv-schema.ts
    kv-schema.test.ts
```

A top-level `test/` directory also works, and fits end-to-end suites that don't map to a single source file.

## CLI reference

See [`mikro test`](/cli#mikro-test) for the full list of options.
