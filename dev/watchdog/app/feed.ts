import {sleep} from 'mikro/sleep'
import {watchdog} from 'mikro/watchdog'

// Sets off the feed watchdog: feeds for a while, then stops while the event
// loop stays healthy. Expect three feeds, then after the 5 s limit:
//   [watchdog] WATCHDOG TRIGGERED: time since last feed() exceeded configured limit of 5000 ms
//   InternalError: watchdog: time since last feed() exceeded configured limit of 5000 ms
//   [panic] restarting in 1000 ms
console.log('watchdog fixture: feeding three times, then going quiet')

for (let i = 1; i <= 3; i++) {
  await sleep(2_000)
  watchdog.feed()
  console.log('feed %d', i)
}

// A timer keeps the loop alive so the restart comes from the feed limit, not
// from the app exiting.
setInterval(() => console.log('still alive, not feeding'), 2_000)
