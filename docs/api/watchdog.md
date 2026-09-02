---
title: watchdog
description: Reboot the device when it stops working
---

# watchdog

```ts twoslash
import {watchdog} from 'mikro/watchdog'
```

An app can fail without crashing. It can freeze in a loop, it can stop making progress while the device still answers, or it can stay awake long past the point it should have slept. A watchdog notices each of these and restarts the device.

The limits are set in [`mikro.config.ts`](/config#watchdog), not from code, so they apply before the first line of your app runs. A hang while modules are still loading is caught the same way as a hang in a timer callback.

## The three settings

| Setting    | Notices                                     | Default        |
| ---------- | ------------------------------------------- | -------------- |
| `blocking` | app code holding the event loop too long    | on, 30 seconds |
| `feed`     | the app stopped making progress             | off            |
| `awake`    | a wake cycle that ran longer than it should | off            |

```ts twoslash
import {defineConfig} from 'mikro'

export default defineConfig({
  watchdog: {
    blocking: 30_000,
    feed: 60_000,
    awake: 120_000,
  },
})
```

### `blocking`

Fires when one turn of the event loop holds the device for longer than the limit. While a turn runs, nothing else does: no timers, no network callbacks, no REPL, no deploy. A runaway `while` loop, an endless microtask chain (`while (true) await 0`) and a regular expression that backtracks forever all look the same from the outside, and this catches all of them.

When it fires, the running code is interrupted with an uncatchable error and you get a stack trace pointing at the line that was running. That is why it interrupts rather than resets: a reset would tell you that the device hung, and a trace tells you where.

```
[watchdog] WATCHDOG TRIGGERED: event loop blocking time exceeded configured limit of 30000 ms
InternalError: interrupted
    at spin (app.js:12)
[panic] restarting in 1000 ms
```

The limit is wall time for the whole turn, whether that time went to JavaScript or to a native call made from it. A sensor or bus read made from a loop counts, because the loop is what holds the device. `lightSleep` does not count: it blocks on purpose, and the clock starts over when it returns.

On by default at 30 seconds. Set `blocking: false` to turn it off. A turn that needs longer than that is rare on a microcontroller; a loop that yields with `await sleep(0)` between chunks of work is usually the better fix.

### `feed`

Fires when the app has gone longer than the limit without calling [`watchdog.feed()`](#watchdog-feed). Off unless configured.

This is for the failure `blocking` cannot see: the event loop is healthy, timers fire, the REPL answers, and the app has stopped doing its job. The usual causes are an `await` that never settles, a state machine stuck in one state, or a queue that nobody drains. The app defines what progress means by where it calls `feed()`, and the config decides how long without progress is too long.

The clock starts over when `lightSleep` returns and when a paused deploy or REPL session resumes. The app could not feed while it was stopped, so it gets the full limit again.

### `awake`

Fires when the device has been awake for longer than the limit since it booted. Off unless configured. For apps that wake from deep sleep, do a bounded piece of work, and sleep again.

Nothing extends it. `feed()` does not reset it, time spent in `lightSleep` counts, and no library can reach it. This is what makes it a budget for the whole wake cycle rather than a preference: it protects the battery even while the app is busy and feeding normally. A device that should be awake for 20 seconds and is still awake an hour later has failed, whatever it is doing.

Leave it unset on a device that stays powered. On a mains device that never sleeps, an awake limit is a reboot timer.

## `watchdog.feed()` {#watchdog-feed}

```ts
function feed(): void
```

Report progress to the `feed` watchdog. A no-op when `watchdog.feed` is not configured, so an app can keep its `feed()` calls while an environment override drops the limit.

```ts twoslash
import {watchdog} from 'mikro/watchdog'
declare function pollSensor(): Promise<void>
// ---cut---
// mikro.config.ts: watchdog: {feed: 30_000}
setInterval(async () => {
  await pollSensor()
  watchdog.feed()
}, 5_000)
```

Call it where real work completed, not from a bare timer. A `feed()` that fires whether or not the work succeeded protects nothing, because the app can be completely stuck and still report progress every five seconds.

Feed on progress the app controls, not on network success. A missed feed on an [OTA trial build](/ota#the-trial-model) counts as a crash and rolls the build back. If `feed()` only runs after a successful upload, one slow night on the link reverts a good build.

A phase that cannot make progress for a while, such as waiting for a long download, should feed from a timer during that phase. A phase too stuck to run that timer should be restarted.

## Choosing an `awake` limit {#choosing-an-awake-limit}

Getting this wrong is expensive and quiet, so it gets its own section.

The case it exists for is a unit mix-up. The app means 100 seconds and writes:

```ts
// Meant 100 seconds. This is 100,000 seconds: about 28 hours.
await sleep(100_000_000)
deepSleep(15 * 60_000)
```

The loop is idle, a `feed()` on an interval keeps feeding, and the battery is gone by morning. With `awake` set, the limit is reached, [`onPanic`](/config#onpanic) deep-sleeps the device, and each cycle costs the limit instead of the whole battery.

The limit must clear the slowest thing the device can do in one wake, not the typical cycle, plus a margin. Several of these can happen in the same wake:

| Step                        | Why it can be slow                                        |
| --------------------------- | --------------------------------------------------------- |
| WiFi association, DHCP, DNS | retries and backoff on a weak or busy link                |
| TLS handshake               | slowest on chips without PSRAM, where it competes for RAM |
| SNTP sync                   | a fresh boot with no clock waits on a round trip          |
| OTA check-in                | a full request and response against the registry          |
| OTA download                | an entire bundle over that same weak link                 |
| config trial                | an extra round on top of the above                        |

These add up rather than replace each other: one unlucky wake retries WiFi, then negotiates TLS, then checks in, then downloads a build. The time a boot-time OTA install takes counts too, since the clock starts at boot rather than when your code runs.

Take a sensor node that wakes every 15 minutes, connects, posts one reading over HTTPS, checks in for updates, and sleeps. A normal cycle takes 8 seconds. The worst case is a weak link: 20 seconds to associate, 5 seconds for TLS, 5 seconds to check in, and 60 seconds to download a 300 KB bundle, about 90 seconds in total. `awake: 180_000` clears that with room to spare, and the device is at most 3 minutes into a bad cycle before it gives up.

A limit shorter than an OTA download does not stop the update. Downloads resume across reboots, so the download takes several cycles, each one paying for association and TLS again and logging a panic, until it lands. The device keeps working, and a corrected limit can still arrive in the next bundle. Even so, size it generously.

Check in for OTA early in the cycle, before the work that might go wrong. A device stuck in a bad cycle then still checks in at the top of every wake, and the fix arrives over the air. A check-in placed after the bad line never runs, and only a cable fixes it.

## What happens when one fires

All three route through [`onPanic`](/config#onpanic). The device waits out the grace window, during which it stays reachable for `mikro deploy --recover`, then restarts or deep-sleeps according to that setting. `blocking` reports an uncaught error with a stack trace first. `feed` reports an error that names the missed limit, without a trace, since no code was running when it fired. `awake` reports only the log line, since no code is at fault; the cycle ran too long.

On an OTA trial build, a `blocking` or `feed` restart counts as a crash and the next boot rolls back. An `awake` restart does not, because a long cycle is usually the link and not the build.

## Watchdog resets in the field

```ts twoslash
import {resetReason} from 'mikro/sys'
// ---cut---
if (resetReason === 'task-watchdog') {
  console.log('Recovering from a hardware watchdog reset')
}
```

[`resetReason`](/api/sys#resetreason) returns `'task-watchdog'` after the hardware task watchdog reset the device. It catches what the three settings above cannot: native code below the JavaScript layer that stopped responding. It is rare, there is no stack trace, and it has no app-facing setting. Worth reading at boot if you track device health.

## During development

`mikro dev` behaves the same as the field. In `mikro sim`, only `blocking` applies: the simulator does not read the `watchdog` config, so `feed` and `awake` never take effect there. If an `awake` limit gets in the way on the bench, override it per environment. Overrides replace the whole `watchdog` group, so an empty object drops `awake` and keeps the default `blocking` limit:

```ts twoslash
import {defineConfig} from 'mikro'

export default defineConfig({
  onPanic: {mode: 'deepSleep', delay: 0, duration: 600_000},
  watchdog: {awake: 120_000},
  env: {development: {watchdog: {}}},
})
```

See [Per-environment overrides](/config#env).

## See also

- [`sleep`](/api/sleep): deep sleep and wakeup sources, the other half of a wake-cycle app
- [Over-the-air updates](/ota#timing): how an `awake` limit interacts with downloads
- [Configuration](/config#watchdog): the `watchdog` key
