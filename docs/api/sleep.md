---
title: sleep
description: Delays, deep sleep, light sleep, and wakeup sources
---

# sleep

```ts twoslash
import {sleep, deepSleep, lightSleep} from 'mikrojs/sleep'
```

Simple delays, deep sleep for battery-powered projects, and light sleep for power-saving idle periods.

## Functions

### sleep(ms)

```ts
function sleep(ms: number): Promise<void>
```

Async delay. Equivalent to `await new Promise(r => setTimeout(r, ms))` but more readable.

```ts twoslash
import {sleep} from 'mikrojs/sleep'

await sleep(1000) // wait 1 second
```

### deepSleep(time)

```ts
function deepSleep(time: number): never
```

Enter deep sleep for `time` microseconds. The device resets on wake, so your program restarts from the beginning. Use [`rtcStorage`](/api/kv) to persist state across deep sleep cycles.

```ts twoslash
import {deepSleep} from 'mikrojs/sleep'
// ---cut---
deepSleep(60_000_000) // sleep for 60 seconds
```

### lightSleep(time)

```ts
function lightSleep(time: number): Result<void, SleepError>
```

Enter light sleep for `time` microseconds. Execution resumes from the same point after waking. RAM is preserved.

```ts twoslash
import {lightSleep} from 'mikrojs/sleep'
// ---cut---
lightSleep(5_000_000).orPanic('light sleep failed') // sleep 5 seconds
```

### getWakeupCause()

```ts
function getWakeupCause(): string
```

Returns the reason the device woke up (e.g., after deep sleep). Useful for branching logic on boot.

```ts twoslash
import {getWakeupCause} from 'mikrojs/sleep'
// ---cut---
const cause = getWakeupCause()
console.log('Woke up because: %s', cause)
```

## Wakeup sources

Configure what can wake the device from sleep. Multiple sources can be active at once.

### enableTimerWakeup(us)

```ts
function enableTimerWakeup(us: number): Result<void, SleepError>
```

Wake up after `us` microseconds.

### enableGpioWakeup(pin, level)

```ts
function enableGpioWakeup(pin: number, level: number): Result<void, SleepError>
```

Wake on GPIO pin state change. For light sleep only. `level`: 4 = low, 5 = high.

### enableExt0Wakeup(pin, level)

```ts
function enableExt0Wakeup(pin: number, level: number): Result<void, SleepError>
```

Wake on a single RTC GPIO pin. For deep sleep. `level`: 0 = low, 1 = high. ESP32, ESP32-S2, ESP32-S3 only.

### enableExt1Wakeup(pinMask, mode)

```ts
function enableExt1Wakeup(pinMask: number, mode: number): Result<void, SleepError>
```

Wake on multiple RTC GPIO pins. For deep sleep. `pinMask` is a bitmask of pin numbers. `mode`: 0 = all low, 1 = any high.

### disableWakeupSource(source?)

```ts
function disableWakeupSource(source?: string): Result<void, SleepError>
```

Disable a specific wakeup source (`"timer"`, `"ext0"`, `"ext1"`, `"gpio"`, `"touchpad"`, `"ulp"`), or all sources if no argument is given.

## Errors

### SleepError

| Variant               | Fields    | Description                         |
| --------------------- | --------- | ----------------------------------- |
| `WakeupConfigFailed`  | `message` | Failed to configure a wakeup source |
| `LightSleepFailed`    | `message` | Light sleep failed to enter         |
| `DisableWakeupFailed` | `message` | Failed to disable a wakeup source   |
