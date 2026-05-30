// Tiny LED helper shared by the sleep examples. Drives the built-in
// user LED via the chip-aware `pins` map. All known XIAO LEDs are
// active-low (write 0 = on, 1 = off), so `setLed(true)` lights it up.

import {digitalWrite, pinMode} from 'mikro/pin'
import {sleep} from 'mikro/sleep'

import {pins} from './pins.js'

pinMode(pins.led, 'OUTPUT').orPanic('Failed to configure LED')

export function setLed(on: boolean): void {
  digitalWrite(pins.led, on ? 0 : 1).orPanic('LED write failed')
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
