import {version} from 'mikro/sys'

// Sets off the blocking watchdog: one event-loop turn that never ends.
// Expect, after the 5 s limit in mikro.config.ts:
//   [watchdog] WATCHDOG TRIGGERED: event loop blocking time exceeded configured limit of 5000 ms
//   InternalError: interrupted
//       at <anonymous> (app/blocking.ts:...)
//   [panic] restarting in 1000 ms
console.log(`watchdog fixture v${version}: blocking the event loop forever`)

// The catch proves the interrupt is uncatchable: the device still restarts.
try {
  while (true) {
    // spin
  }
  // eslint-disable-next-line @mikrojs/no-try-catch -- catching is the point of this fixture
} catch {
  console.log('this line never prints')
}
