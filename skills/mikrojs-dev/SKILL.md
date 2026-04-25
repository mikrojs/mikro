---
name: mikrojs-dev
description: Write efficient, memory-safe JavaScript/TypeScript for the mikrojs runtime on ESP32 microcontrollers. Use this skill whenever the user is writing application code for mikrojs, asking about available APIs, debugging memory issues, handling errors, working with sensors/peripherals from JS, using WiFi/fetch, managing power with deep sleep, or wondering why their code crashes on-device. Also trigger when code uses mikrojs imports, Result types, or targets ESP32 hardware from JavaScript.
---

# Developing for mikrojs

mikrojs runs JavaScript on ESP32 microcontrollers using QuickJS-NG. The runtime has ~80-250KB of heap (depending on chip and PSRAM), no JIT compiler, and a cooperative single-threaded event loop. Code that works in Node.js or the browser may not work here, or may exhaust memory. This skill helps you write code that works within these constraints.

## Runtime differences from Node.js / browsers

**What exists:**

- ES2024 JavaScript (async/await, modules, destructuring, everything)
- `setTimeout`, `setInterval`, `console.log`, `TextEncoder`/`TextDecoder`, `btoa`/`atob`
- `AbortController` with `AbortSignal.timeout()` and `AbortSignal.any()`
- `import.meta.url`, `import.meta.main`, `import.meta.env`

**What does NOT exist:**

- `fetch` is NOT a global. Import `request` from `mikrojs/http/request` (it returns `Result`, not throwing)
- No `fs`, `path`, `crypto`, `Buffer`, `process`, `require()` or any Node.js built-ins
- No DOM, `window`, `document`, `localStorage`, Web Workers
- No `npm` packages that depend on Node.js or browser APIs
- No WASM, no native addons, no CommonJS (`require`)

**Key behavioral differences:**

- Long-running synchronous code blocks the entire event loop (WiFi, timers, everything)
- Memory is measured in KB, not MB. A single large string or array can crash the runtime
- Garbage collection uses reference counting + cycle detection (not generational GC)
- Module imports are lazy; the native module initializes on first import, not at boot

## Error handling: Result, not try/catch

mikrojs uses typed Result values instead of exceptions for expected errors. Every hardware API returns `Result<T, E>` where you check `.ok` before accessing `.value`.

```typescript
import {pinMode, digitalWrite} from 'mikrojs/pin'

// Check the result
const result = pinMode(4, 'OUTPUT')
if (!result.ok) {
  console.error('Failed:', result.error.name)
  // result.error is a typed discriminated union
}

// Chain operations
const value = analogRead(pin).map((raw) => raw / 4095)

// Crash on failure (for unrecoverable situations)
pinMode(LED_PIN, 'OUTPUT').orPanic('LED pin must work')
```

**When to use what:**

- `result.ok` check: normal error handling, retry logic, fallbacks
- `.orPanic()`: setup code where failure means the app can't run
- `.match({ok, err})`: exhaustive handling of all error variants
- `.map(fn)` / `.mapErr(fn)`: transform success or error values
- `.andThen(fn)`: chain operations that themselves return Result
- `try/catch`: only for truly unexpected errors (bugs), not hardware failures

Exceptions (`throw`) are for programmer errors. Result is for expected failures. Never use `try/catch` around hardware APIs.

## Memory management

### Know your budget

```typescript
import {memoryUsage, gc} from 'mikrojs/sys'

const mem = memoryUsage()
const freeKB = (mem.heapTotal - mem.heapUsed) / 1024
console.log(`Free: ${freeKB.toFixed(0)} KB`)
```

Typical free heap after runtime init:

- ESP32 (no PSRAM): ~80-150 KB
- ESP32-S3 with PSRAM: ~8 MB (but JS heap is still limited by QuickJS malloc limit)

### Patterns that waste memory

```typescript
// BAD: string concatenation in loops (creates N intermediate strings)
let csv = ''
for (const row of data) csv += row.join(',') + '\n'

// GOOD: array + join (one allocation)
const lines = data.map((row) => row.join(','))
const csv = lines.join('\n')

// BAD: large JSON parse (allocates entire object tree)
const huge = JSON.parse(bigJsonString)

// GOOD: if you only need one field, extract it
// Or parse smaller chunks

// BAD: creating arrays/objects in hot loops
while (true) {
  const reading = {temp: readSensor(), time: Date.now()} // GC pressure
  await sleep(100)
}

// GOOD: reuse objects
const reading = {temp: 0, time: 0}
while (true) {
  reading.temp = readSensor()
  reading.time = Date.now()
  await sleep(100)
}
```

### When to call gc()

```typescript
// After freeing large resources (WiFi disconnect, closing connections)
wifi.disconnect()
gc()

// Before operations that need headroom (JSON parse, TLS handshake)
gc()
const result = await fetch(url)

// Periodically in long-running loops if memory trends down
const mem = memoryUsage()
if (mem.heapTotal - mem.heapUsed < 20_000) gc()
```

## Async and the event loop

The event loop is single-threaded and cooperative. Long synchronous work blocks everything: WiFi, timers, REPL, and deploy protocol.

```typescript
import {sleep} from 'mikrojs/sleep'

// BAD: blocks the event loop for seconds
for (let i = 0; i < 1_000_000; i++) {
  compute(i)
}

// GOOD: yield periodically
for (let i = 0; i < 1_000_000; i++) {
  compute(i)
  if (i % 1000 === 0) await sleep(0) // yield to event loop
}
```

`await sleep(ms)` (from `mikrojs/sleep`) is the idiomatic way to delay. It yields to the event loop and resumes after the delay. `sleep(0)` yields immediately without delay.

## WiFi and networking

### Connect once, stay connected

```typescript
import {wifi} from 'mikrojs/wifi'
import {request} from 'mikrojs/http/request'

// WiFi uses 40-65 KB of heap. Connecting/disconnecting repeatedly wastes memory.
const conn = await wifi.connect(import.meta.env.WIFI_SSID, import.meta.env.WIFI_PASS)
if (!conn.ok) {
  console.error('WiFi failed:', conn.error)
  // Consider: retry with backoff, or panic if WiFi is required
}

// request returns Result, not throwing
const res = await request('https://api.example.com/data')
if (!res.ok) {
  console.error('Request failed:', res.error.name)
  // RequestError variants: Network, Timeout, BodyTooLarge, InvalidResponse,
  // Aborted, TooManyPending, Hardware
} else {
  const response = res.value
  if (response.ok) {
    const data = await response.json()
  }
}
```

### Cancel requests to free memory

```typescript
// TLS connections hold ~40 KB. Cancel them if they take too long.
const controller = new AbortController()
setTimeout(() => controller.abort(), 5000)

const result = await request(url, {signal: controller.signal})
if (!result.ok && result.error.name === 'Aborted') {
  console.log('Request timed out, memory freed')
}
```

## Environment variables

```typescript
// Destructured access (throws if undefined)
const {WIFI_SSID, API_KEY} = import.meta.env

// Set via CLI:
// mikro env set WIFI_SSID MyNetwork
// mikro env set API_KEY --secret
```

Variable names are limited to 15 characters (NVS storage constraint on ESP32).

## Deep sleep for battery-powered projects

```typescript
import {deepSleep, enableTimerWakeup, getWakeupCause} from 'mikrojs/sleep'
import {rtcStorage} from 'mikrojs/kv'
import * as s from 'mikrojs/schema'

// RTC memory survives deep sleep (but not power loss)
const bootCount = rtcStorage.createValue('boots', {schema: s.number()})
bootCount.update((n) => (n ?? 0) + 1)
console.log(`Boot #${bootCount.get() ?? 0}, cause: ${getWakeupCause()}`)

// Do work: read sensor, send data, etc.
// ...

// Sleep for 5 minutes (microseconds)
enableTimerWakeup(5 * 60 * 1_000_000).orPanic('timer wakeup')
deepSleep(5 * 60 * 1_000_000) // never returns, device reboots on wake
```

Deep sleep draws ~10-20 uA vs. ~80-160 mA active. For battery projects, spend as little time awake as possible.

## npm package compatibility

**Works:** Pure ESM packages with no Node.js/browser dependencies. Small utilities.

**Does not work:** CommonJS, native addons, anything using `node:*` imports, large frameworks.

```typescript
// These work:
import prettyMs from 'pretty-ms' // pure ESM utility
import {format} from 'date-fns/format' // tree-shakeable ESM

// These do NOT work:
import express from 'express' // Node.js APIs
import axios from 'axios' // depends on node:http
import lodash from 'lodash' // CommonJS
```

When in doubt, prefer inlining small utilities over importing packages. Every imported byte increases the deployed app size, and some packages pull in unexpected dependencies.

## Available hardware APIs

| Module     | Import                 | Purpose                     |
| ---------- | ---------------------- | --------------------------- |
| `pin`      | `mikrojs/pin`          | GPIO digital/analog I/O     |
| `pwm`      | `mikrojs/pwm`          | PWM output (LEDs, motors)   |
| `i2c`      | `mikrojs/i2c`          | I2C bus communication       |
| `spi`      | `mikrojs/spi`          | SPI bus communication       |
| `uart`     | `mikrojs/uart`         | UART serial communication   |
| `neopixel` | `mikrojs/neopixel`     | WS2812/SK6812 LED strips    |
| `ble`      | `mikrojs/ble`          | Bluetooth Low Energy        |
| `wifi`     | `mikrojs/wifi`         | WiFi station + access point |
| `request`  | `mikrojs/http/request` | HTTP client (Result-based)  |
| `sleep`    | `mikrojs/sleep`        | Delays, deep/light sleep    |
| `sntp`     | `mikrojs/sntp`         | Network time sync           |
| `kv`       | `mikrojs/kv`           | Key-value storage (RTC/NVS) |
| `env`      | `mikrojs/env`          | Environment variable access |
| `cbor`     | `mikrojs/cbor`         | CBOR encode/decode          |
| `schema`   | `mikrojs/schema`       | Runtime type validation     |
| `result`   | `mikrojs/result`       | Result type utilities       |
| `sys`      | `mikrojs/sys`          | System info, gc, restart    |
| `test`     | `mikrojs/test`         | On-device test framework    |

Board packages re-export drivers with pre-configured pins, so user code imports from the board rather than wiring pins manually:

```typescript
import {display} from '@mikrojs/your-board/your-variant'
display.fillRect(0, 0, 360, 360, 0xf800)
```

## Common mistakes

### Forgetting that `fetch` is not a global

```typescript
// WRONG: fetch is not defined
const res = await fetch(url)

// RIGHT:
import {request} from 'mikrojs/http/request'
const res = await request(url)
```

### Using try/catch for hardware errors

```typescript
// WRONG: hardware APIs return Result, not throw
try {
  const temp = readSensor()
} catch (e) { ... }

// RIGHT:
const result = readSensor()
if (!result.ok) { ... }
```

### Blocking the event loop

```typescript
import {sleep} from 'mikrojs/sleep'

// WRONG: while(true) without await
while (true) {
  checkSensor()
}

// RIGHT: yield to the event loop
while (true) {
  checkSensor()
  await sleep(100)
}
```

### Allocating in hot loops

```typescript
import {sleep} from 'mikrojs/sleep'

// WRONG: creates a new Uint8Array every iteration
while (true) {
  const buf = new Uint8Array(256)
  spi.transfer(buf)
  await sleep(10)
}

// RIGHT: allocate once, reuse
const buf = new Uint8Array(256)
while (true) {
  spi.transfer(buf)
  await sleep(10)
}
```
