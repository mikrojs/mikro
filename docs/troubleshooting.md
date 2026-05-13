---
title: Troubleshooting
description: Recovering from common Mikro.js problems
---

# Troubleshooting

## Recovering a crash-looping device

If your deployed app crashes immediately on boot, the device restarts before you can connect a normal REPL: there's no window to send a `mikro clean` or to deploy a fix. The firmware opens a brief recovery window (~500ms) very early in boot for exactly this case. If triggered, the firmware skips autorun and drops into the protocol loop, where deploy and REPL commands work as normal.

When safe mode is active you'll see this banner in the device output:

```
*** SAFE MODE: autorun skipped, dropping to REPL ***
```

In most cases the thing you actually want is to push a fixed version of your app:

```sh
mikro deploy --recover     # reset into safe mode, then deploy the current source
```

`--recover` toggles RTS to reset the chip via the auto-reset circuit, floods the firmware's sync sequence during the boot window, and then runs the normal deploy flow over the same protocol session. After the deploy completes, the device restarts and boots into the new app, no longer in safe mode. Once it's unstuck you can resume normal work with `mikro dev` (or whatever).

The other two variants:

```sh
mikro clean --recover      # wipe the broken app without redeploying anything
mikro console --recover    # drop into the REPL on the broken device to inspect state first
```

`clean --recover` is the "just wipe it, I'll redeploy later" path. `console --recover` is the "let me poke around before committing to a fix" diagnostic path, useful to inspect `/app`, read env vars, check heap, etc. without losing the deployed state.

`mikro dev` intentionally does **not** have a `--recover` flag. Recovery is a one-shot operation; once you've used `deploy --recover` (or `clean --recover`) to unstick the device, run `mikro dev` normally and it'll work fine.

The options below are listed in escalating order. Try the first one. If it doesn't work, move to the next.

### 1. Host-driven recovery

```sh
mikro deploy --recover
```

Works on any board with the standard auto-reset wiring, which is most dev boards.

### 2. Double-tap reset

Tap the physical RESET button twice within ~500ms. The first reset arms a magic word in RTC memory; if a second reset arrives before the window closes, the next boot enters safe mode. From there, run a normal `mikro deploy` (without `--recover`) to push the fix while the device sits in safe mode.

No host tooling required for the trigger itself, which is useful on bare modules without auto-reset wiring.

### 3. Manual reset assist

For boards where `--recover` can't drive RESET (no auto-reset wiring, broken transistor, or unusual USB-serial bridge):

1. Hold the RESET button on the board.
2. In another terminal, run `mikro deploy --recover`.
3. Release RESET within about a second.

The CLI floods sync bytes for ~1s after opening the port. Releasing RESET during that window lets the firmware boot into the sync window with bytes already arriving.

### 4. Force ROM bootloader and erase

If safe mode itself is broken (firmware corruption, an early-init crash before the recovery window opens, or a bricked LittleFS partition), you can drop into the ESP32 ROM bootloader instead. The ROM is in mask ROM, so it's always reachable regardless of what's on flash.

1. Hold the BOOT (sometimes labeled IO0) button.
2. Tap RESET while still holding BOOT.
3. Release BOOT. The chip is now in download mode and won't run any flash code.
4. Run `mikro erase` to wipe everything, then `mikro flash` to re-install firmware, then `mikro dev` to redeploy your app.

::: warning
`mikro erase` is a full factory reset: it removes firmware, application code, environment variables, and all stored data. You'll need to re-flash and redeploy after.
:::

Boards with USB Serial/JTAG (ESP32-C3, C6, S3, etc.) usually only have a RESET button. On those, the BOOT pin is exposed as a header you can briefly tie to GND, or the board may auto-enter download mode when esptool talks to it. `mikro erase` and `mikro flash` will handle the auto-entry on most boards without needing to touch buttons.

## Post-mortem from logs

A crash-looping device that you've unstuck (see above) leaves a useful breadcrumb behind if [file logging](/config#logfile) was enabled in the app that crashed: a rotated log file on the device filesystem with timestamped console output and ESP_LOG lines up to the moment things went sideways.

Pull it after recovery:

```sh
mikro logs pull          # stream the current + rotated generations to stdout
mikro logs pull ./logs   # archive both as separate files for later inspection
```

The file logger uses `flush: 'error'` by default, so warn/error lines hit flash immediately and survive a hard crash. Routine `console.log` output is buffered and may be lost if the reset happens before the buffer fills — switch to `flush: 'line'` (at the cost of more flash wear) if you need every line to survive.

::: tip Always-on for prod
Enable `logFile: true` in your production `mikro.config.ts`. It costs ~2 KB of RAM and rotates within a `2 × maxSize` flash budget, but it's the difference between "device crashed, no idea why" and "device crashed, here's what it logged."
:::
