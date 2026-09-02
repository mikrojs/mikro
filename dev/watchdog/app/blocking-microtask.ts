import {version} from 'mikro/sys'

// Sets off the blocking watchdog with an endless microtask chain. Every await
// finishes in microseconds, but the loop never returns to the event loop, so
// timers, the REPL and deploy are all frozen. The limit is per event-loop
// turn, not per microtask, so this fires exactly like a bare while loop:
//   [watchdog] WATCHDOG TRIGGERED: event loop blocking time exceeded configured limit of 5000 ms
//   InternalError: interrupted
//       at spin (app/blocking-microtask.ts:...)
//   [panic] restarting in 1000 ms
console.log(`watchdog fixture v${version}: spinning on await 0`)

async function spin() {
  while (true) {
    await 0
  }
}

void spin()
