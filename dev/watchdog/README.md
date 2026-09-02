# watchdog

Dev fixture with one entry per [watchdog](https://mikrojs.dev/api/watchdog), each written to set it off. Deploy an entry, watch the watchdog line and the restart, and you have checked that watchdog on real hardware.

## Entries

| File                        | Fires      | How                                                   | Expect after           |
| --------------------------- | ---------- | ----------------------------------------------------- | ---------------------- |
| `app/blocking.ts`           | `blocking` | a `while (true)` loop inside a `try`                  | 5 s                    |
| `app/blocking-microtask.ts` | `blocking` | `while (true) await 0`, an endless microtask chain    | 5 s                    |
| `app/blocking-regex.ts`     | `blocking` | a regex that backtracks exponentially                 | 5 s                    |
| `app/feed.ts`               | `feed`     | feeds three times, then keeps a timer alive and stops | 3 feeds, then 5 s more |
| `app/awake.ts`              | `awake`    | feeds every second and never sleeps                   | 30 s of uptime         |
| `app/lightsleep.ts`         | nothing    | `lightSleep(8_000)`, longer than both 5 s limits      | must not fire          |

`mikro.config.ts` sets `watchdog: {blocking: 5_000, feed: 5_000, awake: 30_000}` and `onPanic: {mode: 'restart', delay: 1000}`. The values are as low as the runtime's 1 s floor sensibly allows, so each one fires within seconds of the deploy.

## Run

```sh
pnpm install
pnpm dev:blocking
pnpm dev:blocking-microtask
pnpm dev:blocking-regex
pnpm dev:feed
pnpm dev:awake
pnpm dev:lightsleep
```

After a blocking entry, deploy the next one with `--recover`. The blocking app spins for 5 s, panics, and reboots after a 1 s grace window, which is the only time the device serves the protocol, so a plain deploy rarely lands. `pnpm mikro deploy --recover app/feed.ts` catches the device early in boot instead. The trace line names the entry that actually ran, so if it says `blocking.js` when you expected something else, the deploy did not land.

Each entry prints the exact lines to expect at the top of its file. The blocking entries end with a stack trace, the feed entry with an error and no trace, and the awake entry with the watchdog line only. All of them are followed by `[panic] restarting in 1000 ms` and a reboot; `mikro dev` reconnects and the cycle repeats.

The `lightsleep` entry is the negative check: it blocks one turn for 8 s, longer than both the blocking and the feed limit, and must print `light sleep done after 8 s, no watchdog fired`. Both clocks start over when light sleep returns, so neither fires on wake. It then feeds once a second until the awake limit reboots the device at 30 s, which is the shared config doing its job. The line it prints before sleeping is usually lost on USB Serial/JTAG chips (C3, C6, S3), because light sleep drops the USB port before the host has drained it; `mikro logs pull` still has it.

Prefer the console over `mikro dev` for this one. Dropping the USB port makes `mikro dev` reconnect, and the console never restarts the device on its own:

```sh
pnpm mikro deploy --recover app/lightsleep.ts
pnpm mikro console
```

The awake entry also shows the boot warning for `awake` without `onPanic.mode: 'deepSleep'`, since with restart mode the limit is a reboot timer. The deep-sleep pairing a real app uses is in `examples/ota-wake-cycle`.

## Two checks from the REPL

With any entry running under `pnpm dev`:

- Paste `while (true) {}` into the REPL. After 5 s the eval returns `Uncaught InternalError: interrupted`, the session stays up and the app is not restarted. A synchronous throw from a REPL eval never reaches the panic path.
- Type `/pause`, wait longer than a minute, then `/resume`. The device must not reset while paused: the serve loop keeps feeding the hardware task watchdog even though the event loop is stopped. The feed limit gets a fresh window on resume, so `feed.ts` does not fire on the spot either.

## Not covered here

The hardware task watchdog has no JavaScript entry, because nothing an app can do starves it: the event loop and every cooperative yield feed it. Checking it needs a native spin loop compiled into the firmware. After such a reset, `resetReason` from `mikro/sys` reads `'task-watchdog'`.

An `awake` limit that ends in deep sleep needs `onPanic.mode: 'deepSleep'`, which would turn every other entry here into a sleeper too. Check that one on `examples/ota-wake-cycle` with its limit lowered for the test.

## Why this lives in `dev/` instead of `examples/`

It is a test fixture, not a starting point. `dev/crashloop/` and `dev/oom/` are neighbours with the same "deliberately break something to check the runtime handles it" role.
