---
title: Troubleshooting
description: Recovering from common Mikro.js problems
---

# Troubleshooting

## Unable to connect to board

- Try a different USB cable. Some are charge-only and won't enumerate as a serial device.
- Try flipping the cable at the board side. USB-C is reversible by spec, but some boards only wire data on one orientation.
- Try power-cycling the device (unplug it and plug it back in).
- Check that no other program is holding the serial port open (Arduino IDE, esp-idf monitor, screen, minicom, another `mikro` session in a different terminal).
- If multiple serial devices are attached, `mikro` can pick the wrong one. Force a specific port with `--port`, for example `mikro flash --port <port>`.
- The firmware may be out of date or missing. Run `mikro flash` to install or update it.
- The device may be crash-looping, restarting before `mikro` can open the protocol session. See [Recovering a crash-looping device](#recovering-a-crash-looping-device).
- Force the board into download mode: hold BOOT, tap RESET, release BOOT, then run `mikro flash` again. Useful when the auto-reset wiring isn't triggering.

## Recovering a crash-looping device

If your deployed app crashes immediately on boot, the device restarts before you can connect a normal REPL. There's no window to send a `mikro clean` or to deploy a fix. The firmware opens a brief recovery window (~500ms) very early in boot for exactly this case. If triggered, the firmware skips autorun and drops into the protocol loop, where deploy and REPL commands work as normal.

When safe mode is active you'll see this banner in the device output:

```
*** SAFE MODE: autorun skipped, dropping to REPL ***
```

In most cases the thing you actually want is to push a fixed version of your app:

```sh
mikro deploy --recover     # reset into safe mode, then deploy the current source
```

`--recover` toggles RTS to reset the chip via the auto-reset circuit and floods the firmware's sync sequence during the boot window. Then it runs the normal deploy flow over the same protocol session. After the deploy completes, the device restarts and boots into the new app, no longer in safe mode. Once the device is recovered, resume normal work with `mikro dev`.

The other two variants:

```sh
mikro clean --recover      # wipe the broken app without redeploying anything
mikro console --recover    # drop into the REPL on the broken device to inspect state first
```

`clean --recover` is the "just wipe it, I'll redeploy later" path. `console --recover` is the "let me poke around before committing to a fix" diagnostic path, useful to inspect `/app`, read env vars, and check the heap without losing the deployed state.

`mikro dev` intentionally does **not** have a `--recover` flag. Recovery is a one-shot operation; once you've used `deploy --recover` (or `clean --recover`) to recover the device, run `mikro dev` normally.

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

Boards with USB Serial/JTAG (ESP32-C3, ESP32-C6, ESP32-S3, and similar) usually only have a RESET button. On those, the BOOT pin is exposed as a header you can briefly tie to GND, or the board can auto-enter download mode when esptool talks to it. `mikro erase` and `mikro flash` will handle the auto-entry on most boards without needing to touch buttons.

## Post-mortem from logs

A crash-looping device that you've recovered (see above) leaves a useful breadcrumb behind if [file logging](/config#logfile) was enabled in the app that crashed: a rotated log file on the device filesystem with timestamped console output and ESP_LOG lines up to the moment of the crash.

Pull it after recovery:

```sh
mikro logs pull          # stream the current + rotated generations to stdout
mikro logs pull ./logs   # archive both as separate files for later inspection
```

The file logger uses `flush: 'error'` by default, so warn/error lines hit flash immediately and survive a hard crash. Routine `console.log` output is buffered and can be lost if the reset happens before the buffer fills. If you need every line to survive, switch to `flush: 'line'` at the cost of more flash wear.

::: tip Always-on for prod
Enable [`logFile: true`](/config#logfile) in your production `mikro.config.ts`. It costs ~2 KB of RAM and rotates within a `2 × maxSize` flash budget, but it's the difference between "device crashed, no idea why" and "device crashed, here's what it logged."
:::

## PSRAM board reports `board.psram` as 0

ESP32-S3 modules have either quad or octal PSRAM, and the firmware must be built for the right one. When it isn't, the board boots without any error but runs with no PSRAM: `board.psram` from `mikro/sys` is `0`, and allocations fall back to internal SRAM.

The generic ESP32-S3 firmware is built for octal PSRAM (N8R8, N16R8, the XIAO ESP32S3). A board with quad PSRAM, such as an N8R2 module, runs without its PSRAM on the generic firmware. To use it, flash a [board package](/develop/creating-boards) or [custom firmware](/develop/custom-firmware) built for that board. Those builds start from the Mikro.js chip defaults, which use quad mode.

Firmware for an octal PSRAM board sets the mode:

```
CONFIG_SPIRAM_MODE_OCT=y
```

A board package puts it in a settings file that its board lists under `sdkconfig` in `boards.config.ts`. `pn mikro fw build` starts from fresh settings whenever those change; delete the board's generated `sdkconfig` in `.mikro/` (`.mikro/fw/sdkconfig` for the board at `.`) to force it. Custom firmware puts it in the project's `sdkconfig.defaults`, then deletes the generated `sdkconfig`, re-runs `pn mikro idf set-target esp32s3` and builds again: `sdkconfig.defaults` is only read when `sdkconfig` does not exist, so editing it alone has no effect on an already configured build.
