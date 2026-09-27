---
title: Building from Source
description: Build Mikro.js firmware from the monorepo using ESP-IDF
---

# Building from Source

This page covers building firmware from the Mikro.js monorepo. You need this if you are contributing to the core runtime or working with native (C/C++) drivers.

For building custom firmware from npm packages without cloning the monorepo, see [Custom Firmware](./custom-firmware).

## One-time ESP-IDF setup

Install ESP-IDF >= 6.1 using [EIM (ESP-IDF Installation Manager)](https://docs.espressif.com/projects/idf-im-ui/en/latest/):

```sh
eim install -i v6.1 -t all -n true
```

The commands below use [`mikro idf`](/cli#mikro-idf), which runs ESP-IDF's `idf.py` through `eim run` when ESP-IDF is not active in the shell, so no manual activation is needed.

## Building generic firmware

Generic firmware includes the core runtime without any board-specific configuration:

```sh
cd esp32
pn mikro idf set-target esp32c6    # or esp32, esp32s3
pn mikro idf build flash monitor
```

Replace `esp32c6` with your chip. Press `Ctrl+]` to exit the serial monitor.

## Building firmware for a board

A [board package](./creating-boards) builds its firmware from its `boards.config.ts`, not in `esp32/`: the config holds each board's chip, settings and native modules. In the package:

```sh
pn mikro fw prepack
```

`mikro fw prepack` builds every board in the config and writes each image into the folder that the board's `firmware` export points at. An app that depends on the package flashes that image with `mikro flash`.

The generic images that `@mikrojs/firmware` ships are built the same way, from its own `boards.config.ts`: `pn mikro fw prepack --board esp32c6-generic` in `packages/@mikrojs/firmware` builds the one for the C6 into its `dist-fw/`.

## Running on-device tests

From the `esp32/` directory:

```sh
pnpm test
```

This builds the test firmware, flashes it, and runs the Unity test suite over serial. Tests are organized by category: `[runtime]`, `[modules]`, `[timers]`, `[fs]`, `[gpio]`.

If tests fail to build, try a full clean first:

```sh
cd esp32/test
pn mikro idf -B build fullclean
```

## Running host-side tests

The core runtime can also be built and tested on your development machine without any ESP32 hardware:

```sh
pnpm run build:lib
pnpm run test:lib
```

## sdkconfig notes

`sdkconfig.defaults` is only read when `sdkconfig` does not exist. If you change `sdkconfig.defaults` (or switch boards), you must delete `sdkconfig` and re-run `pn mikro idf set-target <chip>` for the changes to take effect. The target chip is stored in `sdkconfig`, so it must be re-set each time.
