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
├── boards.config.ts      the board: chip, settings, native modules
├── sdkconfig.defaults    ESP-IDF settings for the board (optional)
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

## Step 1: Configure the board

`boards.config.ts` says what goes into the board's firmware:

```ts
import {defineBoards} from 'mikro'

export default defineBoards({
  boards: {
    '.': {
      chip: 'esp32s3',
      sdkconfig: 'sdkconfig.defaults',
      nativeModules: ['@acme/drivers/panel'],
    },
  },
})
```

Each key is the export that declares the board: `.` for a package with one board. The package's `exports` must match the config. `mikro fw prepack` and `mikro fw check` stop when they don't, and print the entries to add.

| Field           | Description                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `chip`          | The chip the board is built around: `esp32`, `esp32c3`, `esp32c5`, `esp32c6` or `esp32s3`      |
| `name`          | The name the firmware reports as `sys.board.name`. Default: the export's specifier             |
| `description`   | Shown when `mikro flash` asks which board to flash. Default: the package's description         |
| `sdkconfig`     | ESP-IDF settings, one file or a list, applied after the firmware's own                         |
| `partitions`    | A partition table to use instead of the default one                                            |
| `nativeModules` | The [native modules](./native-modules) to compile in, by the names apps import                 |
| `project`       | A firmware project of your own to build instead (see [below](#a-firmware-project-of-your-own)) |

Next to `boards`, `dist` sets the folder for the images, `dist-fw` by default.

`sdkconfig.defaults` holds the ESP-IDF settings the board needs and the generic firmware doesn't set:

```ini
# 16 MB flash, 8 MB octal PSRAM
CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y
CONFIG_SPIRAM=y
CONFIG_SPIRAM_MODE_OCT=y
```

A partition table replaces the default one (see [Use a bigger flash chip](./custom-firmware#use-a-bigger-flash-chip)). When `user` is the last partition, `mikro flash` stretches it to the end of the chip's flash, so one image serves variants of the board with more flash.

The device reports the board's name as `sys.board.name`, and `mikro flash --board`, `mikro.config.ts` and a registry use the same name.

Add `.mikro/` and `dist-fw/` to `.gitignore`. A board with its own `project` also gets `sdkconfig`, `sdkconfig.old`, `managed_components/` and `dependencies.lock` in that folder; ignore those too.

## Step 2: Build the image

```sh
pn mikro fw prepack
```

`mikro fw prepack` generates a firmware project for the board in `.mikro/fw`, builds it into `.mikro/build-fw` for the board's chip, and writes the image into the folder that the export's `firmware` condition points at. The package's `prepack` script runs it, so `npm pack` and `npm publish` always include a fresh image, and publishing needs ESP-IDF.

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

A native driver's module is in the firmware only if the board lists it in `nativeModules`. Before `mikro deploy` uploads an app, it checks that the device's firmware has every native module the app imports, and stops with the module's name if one is missing. A pure JS driver needs nothing from the firmware.

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

A package can hold several boards, one entry each in `boards.config.ts`, keyed by the board's export:

```ts
import {defineBoards} from 'mikro'

export default defineBoards({
  boards: {
    './t-display': {
      chip: 'esp32',
      description: 'LILYGO T-Display (ESP32, 1.14" ST7789 display)',
      sdkconfig: 't-display.defaults',
      nativeModules: ['@acme/drivers/st7789'],
    },
    './devkit-c6': {chip: 'esp32c6'},
  },
})
```

```json
"exports": {
  "./t-display": {"firmware": "./dist-fw/t-display/firmware.json"},
  "./devkit-c6": {"firmware": "./dist-fw/devkit-c6/firmware.json"}
}
```

Each board's name is its export's specifier (`@acme/boards/t-display`) unless it sets `name`. A package has one board at `.` or boards at `./<board>`, not both. Name each export by its board: `mikro flash` can't list a `firmware` condition under a `./*` pattern.

`mikro fw prepack` builds every board, each in `.mikro/build-fw-<board>`, and writes its image to `dist-fw/<board>/`. `mikro fw prepack --board t-display` builds one. The `prepack` script stays `npm run build && mikro fw prepack`.

Variants of a board that need different builds, such as one with octal PSRAM, are boards of their own. The config is TypeScript, so they can share the rest:

```ts
const devkit = {chip: 'esp32s3', nativeModules: ['@acme/drivers/st7789']} as const

export default defineBoards({
  boards: {
    './devkit-n8': devkit,
    './devkit-n16r8': {...devkit, sdkconfig: 'octal-psram.defaults'},
  },
})
```

A variant with more flash needs no board of its own: `mikro flash` gives the extra flash to the app filesystem.

## A firmware project of your own

A board that needs more than settings, a partition table and native modules, such as its own `main` or other ESP-IDF components, can point `project` at a [custom firmware](./custom-firmware) project in the package:

```ts
export default defineBoards({
  boards: {'.': {chip: 'esp32s3', project: 'firmware'}},
})
```

`mikro fw prepack` then builds that project and gives it the board's name, description and chip. The project's `CMakeLists.txt` lists its native modules in `MIKROJS_NATIVE_MODULES`, and its own `sdkconfig.defaults` and `partitions.csv` apply.
