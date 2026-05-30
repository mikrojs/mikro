# crashloop

Dev fixture that deploys an app which crash-loops on boot. Used to exercise the `--recover` flow on a device that can't be reached via a normal connect.

## What it does

`app/main.ts` throws an uncaught exception as soon as it runs. The runtime always restarts on uncaught exceptions; `mikro.config.ts` shortens the `onPanic` `delay` grace window so the runtime calls `esp_restart()` quickly after the throw. The next boot autoruns the same broken app, throws again, restarts, forever.

Net effect: the device does enter `MIK_StartReplProtocol` briefly between crashes, but it's gone again before a normal `mikro dev` / `mikro deploy` / `mikro clean` can complete its handshake. The crash cycle is short enough that host-side retries alone aren't enough to catch it.

## Deploy it (to break your device on purpose)

```sh
pnpm install
pnpm mikro dev
```

Once you save the file, the device will start crash-looping. Good luck stopping it with plain `mikro clean` — the normal connect path will time out or flap.

## Recover from it

```sh
pnpm mikro clean --recover
```

Or without pnpm:

```sh
mikro clean --recover
```

What happens:

1. CLI opens the serial port and subscribes to the session.
2. `triggerSafeMode` sends `CMD_RESTART`, pulses RTS/DTR, then floods `MIKSAFE\n` sync bytes.
3. Firmware resets, opens its ~500ms recovery window very early in boot (before `mikro.config.ts` is even loaded), catches the sync, drains leftover flood bytes, and enters safe mode with autorun skipped.
4. CLI receives `MSG_READY`, runs the normal clean (delete `/app`, restart), and the device boots fresh with no broken app.

You can also use `--recover` on `deploy`, `dev`, and `console` to push a fix directly instead of just wiping:

```sh
pnpm mikro deploy --recover    # push a fixed build over the crash loop
pnpm mikro dev --recover       # same, but stay in watch mode
pnpm mikro console --recover   # open REPL on a broken device without deploying
```

## The forcible variant

If you want a crash loop that doesn't rely on the panic-restart path, replace the throw in `app/main.ts` with:

```ts
import {restart} from 'mikro/sys'
restart()
```

This calls `esp_restart()` directly from JS with no delay. Faster crash cycle, more brutal — useful for stressing the recovery window detection under tight timing.

## Why this lives in `dev/` instead of `examples/`

It's a test fixture, not a thing anyone should copy as a starting point. `dev/errors/` and `dev/oom/` are neighbors with the same "deliberately break something to check the runtime handles it" role.
