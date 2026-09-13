// Tiny LED helper shared by the sleep examples. Drives the built-in
// user LED via the chip-aware `pins` map. All known XIAO LEDs are
// active-low: driving the pin to 0 lights them up.

import {DigitalOut} from 'mikro/gpio'
import {sleep} from 'mikro/sleep'

import {pins} from './pins.js'

// Start at 1 so the LED is off.
const led = DigitalOut(pins.led, {initial: 1}).orPanic('Failed to configure LED')

export function setLed(on: boolean): void {
  led.write(on ? 0 : 1)
}

/** Blink the LED `count` times with `durationMs` on each phase. */
export async function blinkLed(count = 3, durationMs = 100): Promise<void> {
  for (let i = 0; i < count; i++) {
    setLed(true)
    await sleep(durationMs)
    setLed(false)
    await sleep(durationMs)
  }
}
