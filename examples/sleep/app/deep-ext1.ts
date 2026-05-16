// Deep sleep with EXT1 (RTC-GPIO) wakeup.
//
// Boot blinks the LED 3× so each wake-and-reboot cycle is visible.
// Deep sleep cuts the digital domain — LED stays off.
//
// To wake: pull GPIO 0 LOW — touch it to GND with a jumper wire, or
// wire a button between the pin and GND. mikrojs enables the chip's
// internal RTC pull-up for you (opposite to the wake direction), so
// no external resistor is needed.
//
// GPIO 0 is RTC-capable on every XIAO ESP32 board that supports
// EXT1. On the XIAO header it's labelled D0 on the C6 and D1 on the
// S3 — same chip pin, different silkscreen.
//
// Deep sleep resets the chip on wake, so this whole script runs
// from the top after each wake. `getWakeupCause()` tells you which
// source fired ('ext1' or 'timer').
//
// Run with: pnpm mikro dev app/deep-ext1.ts
import {canWakeFromExt1, deepSleep, sleep} from 'mikrojs/sleep'
import {board, getWakeupCause} from 'mikrojs/sys'

import {blinkLed} from './led.js'

const BUTTON = 0 // RTC-capable on every XIAO chip with EXT1

await blinkLed()

console.log('Boot — wakeup cause: %s', getWakeupCause())

if (!canWakeFromExt1()) {
  // ESP32-C3 has neither EXT0 nor EXT1 — only timer/gpio sources.
  console.log(`EXT1 wakeup is not supported on ${board.chip}. Try app/deep-timer.ts instead.`)
} else {
  await sleep(500)
  console.log(`Deep sleeping. Pull GPIO ${BUTTON} LOW to wake (or wait 10 s)…`)
  deepSleep({
    ext1: {pins: [BUTTON], mode: 'any-low'},
    timer: 10_000,
  })
}
