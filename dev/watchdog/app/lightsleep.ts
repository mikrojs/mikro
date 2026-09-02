import {lightSleep, sleep} from 'mikro/sleep'
import {resetReason, uptime} from 'mikro/sys'
import {watchdog} from 'mikro/watchdog'

// Must NOT set off the blocking or feed watchdog. lightSleep blocks the turn
// for 8 s, longer than both 5 s limits, but it is the one native call that
// blocks on purpose: both clocks start over when it returns. The hardware
// task watchdog is fed on return as well, and esp_timer keeps counting
// through light sleep on real silicon, which is why this is worth checking
// there. Expect:
//   light sleep done after 8 s, no watchdog fired
//   still awake, fed        (once a second)
// followed by the awake limit firing at 30 s of uptime, which is the
// shared config doing its job, not a failure of this entry.
await sleep(3_000)
console.log(
  'watchdog fixture: light-sleeping for 8 s inside one turn (reset reason: %s)',
  resetReason,
)

const before = uptime().boot
lightSleep(8_000)
const slept = Math.round((uptime().boot - before) / 1000)

// On USB Serial/JTAG chips (C3, C6, S3) light sleep drops the USB port and
// the host takes a few seconds to re-enumerate; anything printed before
// then is lost on the console (the log file still has it). Wait it out,
// but stay under the fresh 5 s feed window.
await sleep(3_000)
console.log('light sleep done after %d s, no watchdog fired', slept)

setInterval(() => {
  watchdog.feed()
  console.log('still awake, fed')
}, 1_000)
