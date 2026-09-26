---
name: add-board
description: Scaffold a mikrojs board package for a development board. Use this skill whenever the user wants to add support for a specific ESP32 development board, create a board definition with pin names, configure sdkconfig defaults for a board, build firmware for a board, or set up pre-wired peripherals. Also trigger when the user mentions a specific board by name (e.g. "LilyGo T-Display", "Waveshare", "Seeed XIAO"), wants to define a board package, or asks how to make mikrojs work with their board. Even partial requests like "I have this ESP32-S3 board with a display" should trigger this skill.
---

# Create a mikrojs Board Package

Generate a board package: prebuilt firmware for a development board, declared with a `firmware` export condition, plus an optional JS library with the board's pin names and pre-wired peripherals.

When this skill triggers, gather the required information from the user, then generate the files listed below. The repo's `docs/develop/creating-boards.md` is the reference; read it when in doubt. If the user has demo code or a schematic for the board, read it to extract pin mappings and hardware details. After generating files, guide the user through building and testing.

## What you need from the user

1. **Package name** (e.g. `@acme/devboard` for one board, `@acme/boards` for several). The board's name is the name its firmware reports: the package name by default.
2. **Chip** (`esp32`, `esp32c3`, `esp32c5`, `esp32c6` or `esp32s3`)
3. **Pin map** (GPIO numbers for the board's peripherals, by the labels printed on the board)
4. **Peripherals and their drivers** (display, touch, sensors), and which drivers are native modules
5. **Any special sdkconfig** (PSRAM, flash size, CPU frequency)

## How a board package works

- The package is a custom firmware project: `CMakeLists.txt`, `sdkconfig.defaults`, and optionally `partitions.csv`. `MIKROJS_NATIVE_MODULES` lists every native module the board's peripherals need; nothing is found from imports.
- `pn mikro fw prepack` builds the firmware and writes the image (`firmware.json`, `flasher_args.json` and the files it flashes) into the folder that the package's `firmware` export points at, then checks the package. The package's `prepack` script runs it, so a published package always has a fresh image.
- The `firmware` condition on an export declares the board: `".": {"firmware": "./dist-fw/firmware.json"}`. Apps depend on the package, and `mikro flash` finds the board through that condition.
- The board names itself: the firmware takes the package's name and description, or `MIKROJS_BOARD_NAME` and `MIKROJS_BOARD_DESCRIPTION` in `CMakeLists.txt`. The device reports the name as `sys.board.name`; `mikro flash --board` and `mikro.config.ts` use it.
- There is no extending: apps flash the image as it is. To change a board's firmware, fork the package.
- The JS library (pins, peripherals, tsconfig preset) is ordinary exports that the tools ignore.

## Package structure to generate

Single board:

```
@acme/devboard/
├── package.json
├── CMakeLists.txt         the firmware project
├── sdkconfig.defaults
├── pins.ts
├── display.ts             one module per pre-wired peripheral
├── tsconfig.json          the preset apps extend
├── tsconfig.build.json    builds the library into dist/
├── .gitignore
└── README.md
```

Multi-board: one folder per board, each a firmware project with its own `CMakeLists.txt` (setting `MIKROJS_BOARD_NAME "@acme/boards/<board>"`) and `sdkconfig.defaults`, exported as `"./<board>": {"firmware": "./dist-fw/<board>/firmware.json"}`. The export's key must be the board's folder: that is how `mikro fw prepack` knows which export a folder's build is for. Run `pn mikro fw prepack` in each board's folder; `mikro idf` builds each into `.mikro/build-fw-<board>` of the package.

## Files to generate

### 1. package.json

```json
{
  "name": "@acme/devboard",
  "version": "0.1.0",
  "description": "ACME DevBoard (ESP32-S3, 240x240 ST7789 display)",
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": {"firmware": "./dist-fw/firmware.json"},
    "./pins": "./dist/pins.js",
    "./display": "./dist/display.js",
    "./tsconfig": "./tsconfig.json"
  },
  "files": ["dist", "dist-fw", "tsconfig.json"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
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

Key points:

- `image` must be in `files`: it is gitignored, and `mikro fw check` fails without it.
- `@mikrojs/firmware` is a direct devDependency: the build runs its `mikro-fw` command through `npx`, which finds only the project's own dependencies.
- `mikro` is a plain required peer for the JS library; driver packages are dependencies. No `peerDependenciesMeta`.
- The package's description becomes the board's description, shown when `mikro flash` asks which board to flash.
- In this monorepo, use `"private": true`, `"version": "0.0.0"` and `workspace:*` ranges, and put the package under `packages/@mikrojs/`.

### 2. CMakeLists.txt

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
# Every native module the board's peripherals need, by the names apps import
set(MIKROJS_NATIVE_MODULES "@acme/drivers/panel")

include(${_MIK_CMAKE_PATH})

project(devboard)
```

### 3. sdkconfig.defaults

Only what the board needs and the generic firmware does not set:

```
CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y
CONFIG_SPIRAM=y
CONFIG_SPIRAM_MODE_OCT=y
```

### 4. pins.ts

Pin names as printed on the board, each a GPIO number.

```ts
export const pins = {
  D0: 1,
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

### 5. Pre-wired peripherals (display.ts, ...)

A function that gives the driver the board's pins and returns the driver's `Result`, so the app claims the hardware when it calls it:

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

A native driver imported here must also be in `MIKROJS_NATIVE_MODULES`; `mikro deploy` stops an app that imports a native module the firmware lacks.

### 6. tsconfig.json and tsconfig.build.json

```json
{
  "extends": "mikro/tsconfig/esp32s3-generic"
}
```

Extend the preset for the board's chip. No `include`: paths in an extended config are relative to the board package, not the app. `tsconfig.build.json` extends it, sets `include` to the library's files, `outDir: "dist"`, `declaration: true` and `noEmit: false`.

### 7. .gitignore

```
dist
dist-fw
.mikro
sdkconfig
sdkconfig.old
managed_components/
dependencies.lock
```

## Building and testing

1. Set the chip and build the image:
   ```sh
   pn mikro idf set-target {chip}
   pn mikro fw prepack
   ```
2. `pn mikro fw check` reports anything that would stop the image from flashing or publishing.
3. In an app that depends on the package (a workspace app, or after `npm pack`), run `pn mikro flash`, then deploy a test app that imports from the board package. `mikro flash --build-dir .mikro/build-fw` flashes the build directly.

## Important notes

- `sdkconfig.defaults` applies only when `sdkconfig` doesn't exist. Delete `sdkconfig` and run `set-target` again after changing it.
- A board name has at most 63 characters and the form of a package name, optionally followed by `/<board>`; the build stops otherwise.
- Board modules are bundled and deployed with the app, like any other dependency.
