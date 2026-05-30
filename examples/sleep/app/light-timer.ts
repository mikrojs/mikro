// Light sleep with timer wakeup.
//
// Execution resumes from the same line after waking — no chip reset.
// Boot blinks the LED 3× so you can confirm the firmware is running.
//
// Why the `await sleep(5_000)` between iterations:
// On USJ-console chips (C3/C5/C6/S3/…) `lightSleep` detaches USB so
// `mikro dev` sees a clean disconnect and re-enumerates on wake. Host
// re-enumeration takes ~3–5 s on macOS. Without an awake window, the
// loop calls `lightSleep` again before the host has reopened the port,
// and every `console.log` between iterations is dropped. The 5 s pause
// holds the USB connection up long enough for the host to catch up.
// On battery/standalone this whole concern goes away — drop the pause.
//
// Run with: pnpm mikro dev app/light-timer.ts
import {lightSleep, sleep} from 'mikro/sleep'
import {getWakeupCause} from 'mikro/sys'

import {blinkLed} from './led.js'

await blinkLed()

console.log('Boot — wakeup cause: %s', getWakeupCause())

for (let i = 1; i <= 3; i++) {
  console.log(`[${i}/3] Light sleeping for 2 s…`)
  lightSleep(2_000)
  // note: need a little delay so dev console can reconnect
  await sleep(500)
  console.log('Woke — cause: %s', getWakeupCause())
}

console.log('Done.')
