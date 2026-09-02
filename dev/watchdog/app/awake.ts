import {uptime} from 'mikro/sys'
import {watchdog} from 'mikro/watchdog'

// Sets off the awake watchdog: the app feeds on schedule and never blocks, so
// the other two watchdogs stay quiet, and it never goes to sleep. Expect,
// once the device has been up for the 30 s limit in mikro.config.ts:
//   [watchdog] WATCHDOG TRIGGERED: awake time exceeded configured limit of 30000 ms
//   [panic] restarting in 1000 ms
// No stack trace: nothing was at fault except the cycle running too long.
// The reboot every 30 s is the "awake without deepSleep" case the boot
// warning describes; a real wake-cycle app pairs awake with
// onPanic: {mode: 'deepSleep'}, see examples/ota-wake-cycle.
console.log('watchdog fixture: feeding every second, never sleeping')

setInterval(() => {
  watchdog.feed()
  console.log('awake for %d s, fed', Math.round(uptime().boot / 1000))
}, 1_000)
