// Deep sleep with EXT0 (single RTC-GPIO) wakeup.
//
// EXT0 is the single-pin counterpart to EXT1. On chips that support
// it (ESP32, ESP32-S2, ESP32-S3) it's the simplest way to wake from
// deep sleep with a button press. **EXT0 is NOT supported on
// ESP32-C3, C6, or H2** — those chips only have EXT1. On unsupported
// chips this script prints a note and exits without sleeping; use
// `deep-ext1.ts` instead.
//
// Boot blinks the LED 3× so each wake-and-reboot cycle is visible.
//
// To wake: pull GPIO 0 LOW — touch it to GND with a jumper wire, or
// wire a button between GPIO 0 and GND. mikrojs enables the chip's
// internal RTC pull-up for you, so no external resistor is needed.
// (Adjust the pin to a free RTC-capable pin on your board if 0 is
// already used by a strapping function on that chip.)
//
// Deep sleep resets the chip on wake, so this whole script runs
// from the top after each wake. `getWakeupCause()` reports 'ext0'
// or 'timer'.
//
// Run with: pnpm mikro dev app/deep-ext0.ts
import {canWakeFromExt0, deepSleep, sleep} from 'mikrojs/sleep'
import {board, getWakeupCause} from 'mikrojs/sys'

import {blinkLed} from './led.js'

const BUTTON = 0 // RTC-capable on ESP32 / S2 / S3

await blinkLed()

console.log('Boot — wakeup cause: %s', getWakeupCause())

if (!canWakeFromExt0()) {
  console.log(`EXT0 wakeup is not supported on ${board.chip}. Try app/deep-ext1.ts instead.`)
} else {
  await sleep(500)
  console.log(`Deep sleeping. Pull GPIO ${BUTTON} LOW to wake (or wait 10 s)…`)
  deepSleep({
    ext0: {pin: BUTTON, level: 'low'},
    timer: 10_000,
  })
}
