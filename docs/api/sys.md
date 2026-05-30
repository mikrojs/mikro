---
title: sys
description: 'System utilities: memory, uptime, GC, restart'
---

# sys

```ts twoslash
import {
  memoryUsage,
  uptime,
  gc,
  restart,
  exit,
  panic,
  board,
  firmware,
  deviceId,
  version,
} from 'mikro/sys'
```

System-level functions for memory monitoring, timing, garbage collection, device info, and environment variables.

## Functions

### memoryUsage()

```ts
function memoryUsage(): MemoryUsage
```

Returns current heap usage.

```ts twoslash
import {memoryUsage} from 'mikro/sys'
// ---cut---
const mem = memoryUsage()
const free = mem.heapTotal - mem.heapUsed
console.log('Free memory: %dKB', free / 1000)
```

### uptime()

```ts
function uptime(): Uptime
```

Returns time since boot and RTC time.

```ts twoslash
import {uptime} from 'mikro/sys'
// ---cut---
const {boot, rtc} = uptime()
console.log('Up for %d ms', boot)
console.log('RTC: %d ms', rtc)
```

| Property | Description                                         |
| -------- | --------------------------------------------------- |
| `boot`   | Milliseconds since last boot (resets on deep sleep) |
| `rtc`    | Milliseconds from RTC clock (survives deep sleep)   |

### gc()

```ts
function gc(): void
```

Runs the cycle collector. Not normally needed: QuickJS frees objects as soon as the last reference drops, via reference counting. The cycle collector only reclaims memory held by reference cycles (objects that refer to each other).

### restart()

```ts
function restart(): never
```

Restarts the device immediately.

### getWakeupCause()

```ts
function getWakeupCause(): string
```

Returns why the device booted. Useful for branching logic right after a deep sleep cycle.

```ts twoslash
import {getWakeupCause} from 'mikro/sys'
// ---cut---
const cause = getWakeupCause()
console.log('Woke up because: %s', cause)
```

Possible values: `'timer'`, `'ext0'`, `'ext1'`, `'gpio'`, or `'undefined'` (cold boot or unknown).

### exit(exitCode?)

```ts
function exit(exitCode?: number): never
```

Stops the current program. On device, this returns to the REPL.

### panic(message)

```ts
function panic(message: string): never
```

Immediately crashes with an error message. Use for truly unrecoverable situations.

### board

```ts
const board: BoardInfo
```

Board and hardware info, evaluated once at startup.

```ts twoslash
import {board} from 'mikro/sys'
// ---cut---
console.log('%s - %d core(s)', board.chip, board.cores)
console.log('Features: %s', board.features.join(', '))
console.log('Flash: %dMB', board.flash / 1024 / 1024)
```

| Property   | Description                                                               |
| ---------- | ------------------------------------------------------------------------- |
| `name`     | Board name from the firmware build (e.g. `"xiao-esp32c6"`) or `"generic"` |
| `chip`     | Chip target (e.g. `"esp32c6"`) or `"host"`                                |
| `cores`    | Number of CPU cores                                                       |
| `revision` | Silicon revision (major \* 100 + minor on ESP32, 0 on host)               |
| `features` | Supported features (e.g. `["wifi", "ble"]`)                               |
| `flash`    | Flash size in bytes (0 on host)                                           |
| `psram`    | PSRAM size in bytes (0 if unavailable)                                    |

### firmware

```ts
const firmware: FirmwareInfo
```

Firmware build identifiers. Useful for debugging and detecting firmware changes.

```ts twoslash
import {firmware} from 'mikro/sys'
// ---cut---
console.log('Build: %s', firmware.hash)
console.log('Date: %s', firmware.date)
```

| Property     | Description                                 |
| ------------ | ------------------------------------------- |
| `hash`       | ELF SHA256 hash on ESP32, `"dev"` on host   |
| `date`       | Build date and time                         |
| `idfVersion` | ESP-IDF version string, `undefined` on host |

### version

```ts
const version: string
```

The mikrojs firmware version, baked in at build time from the workspace `package.json` (e.g. `"0.1.0"`). Always a valid [semver](https://semver.org/) string. Falls back to `"0.0.0-dev"` if the build did not set `MIK_FW_VERSION`.

```ts twoslash
import {version} from 'mikro/sys'
// ---cut---
console.log('mikrojs %s', version)
```

### deviceId

```ts
const deviceId: string
```

A unique device identifier encoded as [Crockford's Base32](https://www.crockford.com/base32.html) (10 lowercase characters, no special symbols).

```ts twoslash
import {deviceId} from 'mikro/sys'
// ---cut---
console.log('Device: %s', deviceId)
// e.g. "5dsgr8kwev"
```

On ESP32, derived from the chip's base MAC address. The encoding is lossless: decoding the 10 characters yields the original 6 MAC bytes. On host/Node builds, derived from the hostname (stable across restarts on the same machine).

### setSystemTime(timestamp)

```ts
function setSystemTime(timestamp: number): void
function setSystemTime(date: Date): void
```

Sets the system clock. Typically called after SNTP sync or with a known timestamp.

## Types

### MemoryUsage

```ts
interface MemoryUsage {
  heapUsed: number
  heapTotal: number
}
```

### Uptime

```ts
interface Uptime {
  readonly boot: number // ms since boot
  readonly rtc: number // ms from RTC
}
```

### BoardInfo

```ts
interface BoardInfo {
  name: string
  chip: string
  cores: number
  revision: number
  features: string[]
  flash: number
  psram: number
}
```

### MonotonicTimestamp

A timestamp based on uptime that is not affected by NTP adjustments. Useful for measuring elapsed time reliably, and for logging events before the device clock is synced via NTP.

```ts twoslash
import {MonotonicTimestamp} from 'mikro/sys'
// ---cut---
const start = MonotonicTimestamp.now()
// ... do work ...
const elapsed = MonotonicTimestamp.now().since(start)
console.log('Took %d ms', elapsed)
```

Logging events before NTP sync:

```ts twoslash
// ---cut---
import {MonotonicTimestamp} from 'mikro/sys'

const events: Array<{ts: MonotonicTimestamp; msg: string}> = []

// These timestamps are captured before NTP has synced
events.push({ts: MonotonicTimestamp.now(), msg: 'WiFi connected'})
events.push({ts: MonotonicTimestamp.now(), msg: 'MQTT broker reached'})

// Later, after NTP sync, convert to wall-clock times.
// toDate() returns err('ClockNotSynced') if the resolved time is
// before the firmware build date (i.e. the clock hasn't been synced).
for (const event of events) {
  const result = event.ts.wallDate()
  if (result.ok) {
    console.log(`[${result.value.toISOString()}] ${event.msg}`)
  } else {
    console.log(`[uptime:${event.ts.uptimeMs}ms] ${event.msg}`)
  }
}
```

| Method                     | Description                                                       |
| -------------------------- | ----------------------------------------------------------------- |
| `MonotonicTimestamp.now()` | Create a timestamp at the current moment                          |
| `.since(other)`            | Milliseconds elapsed since another timestamp                      |
| `.wallDate()`              | Convert to a `Date`, or err `'ClockNotSynced'` if clock isn't set |
