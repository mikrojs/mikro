---
title: Building from Source
description: Build Mikro.js firmware from the monorepo using ESP-IDF
---

# Building from Source

This page covers building firmware from the mikrojs monorepo. You need this if you are contributing to the core runtime or working with native (C/C++) drivers.

For building custom firmware from npm packages without cloning the monorepo, see [Custom Firmware](./custom-firmware).

## One-time ESP-IDF setup

Install ESP-IDF >= 6.0.1 using [EIM (ESP-IDF Installation Manager)](https://docs.espressif.com/projects/idf-im-ui/en/latest/):

```sh
eim install -i v6.0.2 -t all -n true
```

Then allow direnv in the `esp32/` directory (adds the monorepo's `idf.py` wrapper to your PATH):

```sh
cd esp32
direnv allow
```

The `idf.py` command is provided by the monorepo-internal `@repo/idf.py` package and runs through `eim run`, so no manual ESP-IDF activation is needed.

## Building generic firmware

Generic firmware includes the core runtime without any board-specific configuration:

```sh
cd esp32
idf.py set-target esp32c6    # or esp32, esp32s3
idf.py build flash monitor
```

Replace `esp32c6` with your chip. Press `Ctrl+]` to exit the serial monitor.

## Building board-specific firmware

Board packages add drivers, pin maps, and sdkconfig defaults for a specific development board.

1. Add the board package to `esp32/package.json` dependencies:

   ```json
   {
     "dependencies": {
       "@mikrojs/acme": "workspace:*"
     }
   }
   ```

2. Install dependencies:

   ```sh
   pnpm install
   ```

3. Delete the existing sdkconfig and re-set the target. This is required because `sdkconfig.defaults` is only applied when `sdkconfig` does not exist:

   ```sh
   cd esp32
   rm sdkconfig
   idf.py set-target esp32c6
   ```

4. Build with the board name:

   ```sh
   MIKROJS_BOARD=acme-devboard idf.py build flash monitor
   ```

The `MIKROJS_BOARD` environment variable selects the board definition from the package's `mikro.boards` manifest. The board's `sdkconfig.defaults` is automatically merged with the base config during the CMake configure step.

## Running on-device tests

From the `esp32/` directory:

```sh
pnpm test
```

This builds the test firmware, flashes it, and runs the Unity test suite over serial. Tests are organized by category: `[runtime]`, `[modules]`, `[timers]`, `[fs]`, `[gpio]`.

If tests fail to build, try a full clean first:

```sh
cd esp32/test
idf.py fullclean
```

## Running host-side tests

The core runtime can also be built and tested on your development machine without any ESP32 hardware:

```sh
pnpm run build:lib
pnpm run test:lib
```

## sdkconfig notes

`sdkconfig.defaults` is only read when `sdkconfig` does not exist. If you change `sdkconfig.defaults` (or switch boards), you must delete `sdkconfig` and re-run `idf.py set-target <chip>` for the changes to take effect. The target chip is stored in `sdkconfig`, so it must be re-set each time.
