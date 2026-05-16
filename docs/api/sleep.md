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

### deepSleep(sources)

```ts
function deepSleep(sources: DeepWakeupSources | number): never
```

Enter deep sleep until one of the configured `sources` wakes the device. The chip resets on wake, so your program restarts from the beginning. Use [`rtcStorage`](/api/kv) to persist state across deep sleep cycles.

Pass a number as shorthand for a timer-only wakeup in milliseconds:

```ts twoslash
import {deepSleep} from 'mikrojs/sleep'
// ---cut---
deepSleep(60_000) // wake in 60 seconds
```

You can combine sources. The chip wakes when any of them fires:

```ts twoslash
import {deepSleep} from 'mikrojs/sleep'
// ---cut---
deepSleep({
  timer: 60 * 60 * 1000, // 1 hour
  ext0: {pin: 4, level: 'low'}, // ...or a button press
})
```

### lightSleep(sources)

```ts
function lightSleep(sources: LightWakeupSources | number): void
```

Enter light sleep until one of the configured `sources` wakes the device. Execution resumes from the same point after waking; RAM is preserved.

Pass a number as shorthand for a timer-only wakeup in milliseconds:

```ts twoslash
import {lightSleep} from 'mikrojs/sleep'
// ---cut---
lightSleep(5000) // wake in 5 seconds
```

Throws if the chip refuses to sleep. This is unrecoverable in practice and indicates a programming error: no wakeup source configured, a GPIO wakeup already in its trigger state, or a peripheral that's busy (mid-handshake WiFi, active SPI DMA, etc.). Fix the caller rather than catching the throw.

::: info Light sleep drops the USB console
On chips with built-in USB Serial/JTAG (C3, C6, S3, and others), light sleep powers down the USB peripheral. The host sees the device disconnect, and `mikro dev` (or `idf.py monitor`) is left holding a port that no longer exists. Any `console.log` after the sleep won't make it through.

The device keeps running normally; only the log stream is affected. Restart the monitor to see output again after wake.
:::

## Wakeup sources

Each function takes its own source type. Combine sources by passing multiple fields in one call — the chip wakes when any of them fires. Calling `deepSleep` or `lightSleep` replaces any previously-configured sources with exactly what's passed in.

```ts
type LightWakeupSources = {
  timer?: number
  gpio?: {pin: number; level: 'high' | 'low'}
}

type DeepWakeupSources = {
  timer?: number
  ext0?: {pin: RtcGpio; level: 'high' | 'low'}
  ext1?: {pins: RtcGpio[]; mode: 'any-low' | 'any-high'}
}

type RtcGpio = number
```

The two sleep modes have different wake-source paths in ESP-IDF — `gpio` only fires during light sleep, and `ext0`/`ext1` only fire during deep sleep — so the API surfaces them separately.

### `timer`

Milliseconds until wake. Fractional values are allowed, so `0.01` is 10 µs. Works in both deep and light sleep.

### `gpio` (light sleep)

Wake when `pin` reaches `level`. Any GPIO works.

### `ext0` (deep sleep)

Wake when an RTC-capable pin reaches `level`. **ESP32, ESP32-S2, ESP32-S3 only** — throws on C3, C6, H2 (use `ext1` instead).

### `ext1` (deep sleep)

Wake as soon as any of the RTC-capable `pins` matches `mode`: `'any-low'` fires when one goes low; `'any-high'` fires when one goes high.

### `RtcGpio`

Type alias for `number` documenting that the pin must be RTC-capable. Set varies per chip: C6/H2 = 0–7, C3 = 0–5, S2/S3 = 0–21, ESP32 = subset of 0–39. Not statically validated; non-RTC pins throw at runtime.

Invalid inputs (bad `level` string, pins that don't support wakeup, capability missing on the current chip) throw. These are programmer errors; fix the call rather than catching.

## Chip capability helpers

For code that needs to target multiple ESP32 variants, gate `ext0` / `ext1` calls with these:

### canWakeFromExt0()

```ts
function canWakeFromExt0(): boolean
```

Returns `true` on chips that support EXT0 wakeup (ESP32, ESP32-S2, ESP32-S3). `false` on C3, C6, H2, and other newer variants — use `ext1` there.

### canWakeFromExt1()

```ts
function canWakeFromExt1(): boolean
```

Returns `true` on every chip mikrojs targets except ESP32-C3. C3 has neither EXT0 nor EXT1; deep-sleep wake on C3 is timer-only.
