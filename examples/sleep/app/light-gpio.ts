// Light sleep with GPIO wakeup.
//
// Boot blinks the LED 3× so you can confirm the firmware is running.
//
// To wake: pull the **D7** header pad LOW — touch it to GND with a
// jumper wire, or wire a button between D7 and GND. The internal
// pull-up holds the pin HIGH when idle, so no external resistor is
// needed. The chip also wakes on the 10-second timer as a fallback.
//
// D7 maps to a different chip pin on each XIAO board (see app/pins.ts).
// Light-sleep GPIO wake works on any GPIO, so swap in whichever
// header pin is convenient on your breadboard.
//
// Run with: pnpm mikro dev app/light-gpio.ts
import {pinMode} from 'mikro/pin'
import {lightSleep, sleep} from 'mikro/sleep'
import {getWakeupCause} from 'mikro/sys'

import {blinkLed} from './led.js'
import {pins} from './pins.js'

pinMode(pins.buttonPin, 'INPUT_PULLUP').orPanic('Failed to configure button pin')
await blinkLed()

console.log('Boot — wakeup cause: %s', getWakeupCause())

for (let i = 1; i <= 5; i++) {
  console.log(`[${i}/5] Sleeping. Pull D7 (GPIO ${pins.buttonPin}) LOW to wake (or wait 10 s)…`)
  lightSleep({
    gpio: {pin: pins.buttonPin, level: 'low'},
    timer: 10_000,
  })
  // note: need a little delay so dev console can reconnect
  await sleep(500)

  console.log('Woke — cause: %s', getWakeupCause())
  // Debounce so a held button doesn't immediately re-wake.
  await sleep(300)
}

console.log('Done.')
