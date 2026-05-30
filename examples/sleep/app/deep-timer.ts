// Deep sleep with timer wakeup.
//
// Deep sleep cuts power to almost everything, so on wake the chip
// resets and this script runs from the top again. Boot blinks the
// LED 3× so each cycle is visible.
//
// Run with: pnpm mikro dev app/deep-timer.ts
import {deepSleep, sleep} from 'mikro/sleep'
import {getWakeupCause} from 'mikro/sys'

import {blinkLed} from './led.js'

await blinkLed()

console.log('Boot — wakeup cause: %s', getWakeupCause())

await sleep(1000)

console.log('Deep sleeping for 5 s (chip will reset on wake)…')
deepSleep(5_000)
