---
title: Creating Boards
description: Publish prebuilt firmware for a development board, with its pin names and drivers wired to its pins
---

# Creating Boards

A board package provides the firmware for a development board, and optionally the pin names and drivers wired to its pins that apps import.

Apps install board packages as a dependency, and `mikro flash` flashes the board's firmware.

## Anatomy of a board package

```
@acme/devboard/
├── package.json
├── CMakeLists.txt        the firmware project
├── sdkconfig.defaults    ESP-IDF settings for the board
├── dist-fw/              the firmware image; written by mikro fw prepack, not in git
├── pins.ts, display.ts   the JS library for apps (optional)
└── dist/                 the library's build output
```

```json
{
  "name": "@acme/devboard",
  "version": "0.1.0",
  "description": "ACME DevBoard (ESP32-S3, 240x240 ST7789 display)",
  "type": "module",
  "exports": {
    ".": {"firmware": "./dist-fw/firmware.json"},
    "./pins": "./dist/pins.js",
    "./display": "./dist/display.js"
  },
  "files": ["dist", "dist-fw"],
  "scripts": {
    "build": "tsc",
    "prepack": "npm run build && mikro fw prepack"
  },
  "dependencies": {
    "@acme/drivers": "^0.1.0"
  },
  "peerDependencies": {
    "mikro": "^0.1.0"
  },
  "devDependencies": {
    "@mikrojs/firmware": "^0.1.0",
    "mikro": "^0.1.0"
  }
}
```

The `firmware` condition on an export declares the board: it points at the image's `firmware.json`. `mikro flash` looks for it in the exports of an app's dependencies. The other exports are the JS library, which the tools ignore.

## Step 1: The firmware project

The package is a [custom firmware](./custom-firmware) project. `CMakeLists.txt` lists the native modules the board needs:

```cmake
cmake_minimum_required(VERSION 3.22)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)

execute_process(
    COMMAND npx --no --package=@mikrojs/firmware -- mikro-fw cmake-path esp32
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
    OUTPUT_VARIABLE _MIK_CMAKE_PATH
    OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY
)
set(MIKROJS_NATIVE_MODULES "@acme/drivers/panel")

include(${_MIK_CMAKE_PATH})

project(devboard)
```

`sdkconfig.defaults` configures the ESP-IDF settings the board needs and the generic firmware doesn't set:

```ini
# 16 MB flash, 8 MB octal PSRAM
CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y
CONFIG_SPIRAM=y
CONFIG_SPIRAM_MODE_OCT=y
```

A `partitions.csv` next to `sdkconfig.defaults` replaces the default partition table (see [Use a bigger flash chip](./custom-firmware#use-a-bigger-flash-chip)).

The firmware takes the package's name and description. The device reports the name as `sys.board.name`, and `mikro flash --board`, `mikro.config.ts` and a registry use the same name.

Add `.mikro/`, `dist-fw/`, `sdkconfig`, `sdkconfig.old`, `managed_components/` and `dependencies.lock` to `.gitignore`.

## Step 2: Build the image

Set the chip once, then build:

```sh
pn mikro idf set-target esp32s3
pn mikro fw prepack
```

`mikro fw prepack` builds the firmware and writes the image into the folder that the export's `firmware` condition points at. The export's key says which firmware project builds it: `.` is the project at the package root. The folder is yours to choose; `dist-fw/` is the convention. The package's `prepack` script runs it, so `npm pack` and `npm publish` always include a fresh image, and publishing needs ESP-IDF.

To try the image on a device before you publish, flash it from an app in the same workspace that depends on the package, or with `mikro flash --build-dir .mikro/build-fw`.

`mikro fw prepack` then checks the package and stops if the image wouldn't flash or publish. `mikro fw check` runs the same checks without building, for example in CI.

## Step 3: The JS library (optional)

### pins.ts

Export the board's pin names, as printed on the board or in its datasheet. Each name is a GPIO number, so you can give it to the core APIs: `DigitalOut(pins.D0)`.

```ts
export const pins = {
  D0: 1,
  D1: 2,
  LCD_CLK: 12,
  LCD_MOSI: 11,
  LCD_CS: 10,
  LCD_DC: 9,
  LCD_RST: 8,
  LCD_BL: 7,
} as const

export const LCD_WIDTH = 240
export const LCD_HEIGHT = 240
```

### Pre-wired peripherals

A peripheral module imports a driver and gives it the board's pins:

```ts
import {Panel} from '@acme/drivers/panel'

import {LCD_HEIGHT, LCD_WIDTH, pins} from './pins.js'

export function display() {
  return Panel({
    spiHost: 1,
    clk: pins.LCD_CLK,
    mosi: pins.LCD_MOSI,
    cs: pins.LCD_CS,
    dc: pins.LCD_DC,
    reset: pins.LCD_RST,
    backlight: pins.LCD_BL,
    width: LCD_WIDTH,
    height: LCD_HEIGHT,
  })
}
```

Export a function rather than a peripheral object, so that the app claims the hardware when it calls `display()` and gets the driver's `Result` to handle.

A native driver's module is in the firmware only if the firmware project lists it in `MIKROJS_NATIVE_MODULES`. Before `mikro deploy` uploads an app, it checks that the device's firmware has every native module the app imports, and stops with the module's name if one is missing. A pure JS driver needs nothing from the firmware.

### tsconfig preset

Export a `tsconfig.json` that extends the preset for the board's chip:

```json
{
  "extends": "mikro/tsconfig/esp32s3-generic"
}
```

Apps then extend the board's preset, and an import that the chip can't supply, such as `mikro/ble` on a chip without Bluetooth, becomes a type error:

```json
{
  "extends": "@acme/devboard/tsconfig",
  "include": ["./**/*"]
}
```

Add `"./tsconfig": "./tsconfig.json"` to `exports` and `tsconfig.json` to `files`. Don't set `include` in the board's `tsconfig.json`: paths in an extended config are relative to the board package, not the app.

## Using a board in an app

```sh
pn add @acme/devboard
```

```ts
import {display} from '@acme/devboard/display'
import {pins} from '@acme/devboard/pins'
import {DigitalOut} from 'mikro/gpio'

const led = DigitalOut(pins.D0).orPanic()
const lcd = display().orPanic()
```

```sh
pn mikro flash
```

When an app's dependencies include exactly one board, `mikro flash` flashes it. With several, it flashes the one for the connected chip, and asks when several are for that chip; `--board` and `board` in `mikro.config.ts` choose without asking. Before it writes anything, `mikro flash` checks that the connected chip matches the board.

## Multi-board packages

A package can hold several boards, each in a folder that is a firmware project of its own, with its own `CMakeLists.txt` and settings:

```
@acme/boards/
├── package.json
├── t-display/
│   ├── CMakeLists.txt
│   └── sdkconfig.defaults
├── devkit-c6/
│   └── CMakeLists.txt
└── dist-fw/              the images; written by mikro fw prepack, not in git
    ├── t-display/
    └── devkit-c6/
```

```json
"exports": {
  "./t-display": {"firmware": "./dist-fw/t-display/firmware.json"},
  "./devkit-c6": {"firmware": "./dist-fw/devkit-c6/firmware.json"}
}
```

An export's key is the folder of the firmware project that builds its image: `mikro fw prepack` in `t-display/` writes the image of `./t-display`.

Each board's `CMakeLists.txt` sets the board's name and description, which would otherwise be the package's:

```cmake
set(MIKROJS_BOARD_NAME "@acme/boards/t-display")
set(MIKROJS_BOARD_DESCRIPTION "LILYGO T-Display (ESP32, 1.14\" ST7789 display)")
```

Build each board in its folder. `mikro idf` keeps a build for each, in `.mikro/build-fw-<folder>` of the package:

```sh
cd t-display
pn mikro idf set-target esp32
pn mikro fw prepack
```

The package's `prepack` script runs `mikro fw prepack` in each board's folder:

```json
"prepack": "npm run build && (cd t-display && mikro fw prepack) && (cd devkit-c6 && mikro fw prepack)"
```

Name each export by its folder: `mikro flash` can't list a `firmware` condition under a `./*` pattern.
