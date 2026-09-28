---
name: add-board
description: Scaffold a mikrojs board package for a development board. Use this skill whenever the user wants to add support for a specific ESP32 development board, create a board definition with pin names, configure sdkconfig defaults for a board, build firmware for a board, or set up pre-wired peripherals. Also trigger when the user mentions a specific board by name (e.g. "LilyGo T-Display", "Waveshare", "Seeed XIAO"), wants to define a board package, or asks how to make mikrojs work with their board. Even partial requests like "I have this ESP32-S3 board with a display" should trigger this skill.
---

# Create a mikrojs Board Package

Generate a board package: prebuilt firmware for a development board, declared with a `firmware` export condition, plus an optional JS library with the board's pin names and pre-wired peripherals.

When this skill triggers, gather the required information from the user, scaffold the package with `create mikro <name> --board`, then edit the files it writes as described below. The repo's `docs/develop/creating-boards.md` is the reference; read it when in doubt. If the user has demo code or a schematic for the board, read it to extract pin mappings and hardware details. After generating files, guide the user through building and testing.

## What you need from the user

1. **Package name** (e.g. `@acme/devboard` for one board, `@acme/boards` for several). The board's name is the name its firmware reports: the package name by default.
2. **Chip** (`esp32`, `esp32c3`, `esp32c5`, `esp32c6` or `esp32s3`)
3. **Pin map** (GPIO numbers for the board's peripherals, by the labels printed on the board)
4. **Peripherals and their drivers** (display, touch, sensors), and which drivers are native modules
5. **Any special sdkconfig** (PSRAM, flash size, CPU frequency)

## How a board package works

- `boards.config.ts` at the package root describes the board: `chip`, `sdkconfig` (fragments), `partitions`, and `nativeModules` (every native module the board's peripherals need; nothing is found from imports). There is no CMake project to write.
- `pn mikro fw build` generates a firmware project from the config, builds it, and writes the image (`firmware.json`, `flasher_args.json` and the files it flashes) into the folder that the board's `firmware` export points at, then checks the package. The package's `prepack` script runs it, so a published package always has a fresh image.
- The `firmware` condition on an export declares the board: `".": {"firmware": "./dist-fw/full/firmware.json"}`. It must match the config: `mikro fw build` and `mikro fw check` print the entries to add when it doesn't. Apps depend on the package, and `mikro flash` finds the board through that condition.
- The board names itself: the name is the export's specifier (the package name for `.`), or `name` in the config; the description is the package's, or `description`. The device reports the name as `sys.board.name`; `mikro flash --board` and `mikro.config.ts` use it.
- `images: [{ble: false}]` on a board also builds leaner images (features `ble`, `wifi`), named `no-ble` and so on; apps pick one by what they need (`mikro flash --features wifi` gives the leanest with WiFi, `--features full` the full image). Add them only when the board's users need the flash or RAM back.
- There is no extending: apps flash the image as it is. To change a board's firmware, fork the package.
- The JS library (pins, peripherals, tsconfig preset) is ordinary exports that the tools ignore.

## Package structure

Single board (`create mikro <name> --board` writes all of these except `sdkconfig.defaults` and the peripheral modules):

```
@acme/devboard/
├── package.json
├── boards.config.ts       the board: chip, settings, native modules
├── sdkconfig.defaults     only if the board needs settings of its own
├── pins.ts
├── display.ts             one module per pre-wired peripheral
├── tsconfig.json          the preset apps extend
├── tsconfig.build.json    builds the library into dist/
├── .gitignore
└── README.md
```

Multi-board: one entry per board in `boards.config.ts`, keyed `./<board>`, each exported as `"./<board>": {"firmware": "./dist-fw/<board>/full/firmware.json"}`; the name defaults to `@acme/boards/<board>`. One `pn mikro fw build` in the package builds them all (each into `.mikro/build-fw-<board>`); `--board <board>` builds one. Variants that need different builds (octal PSRAM, say) are boards of their own that share a base object in the config; a variant with more flash needs none, since `mikro flash` gives the extra flash to the filesystem.

## Step 1: Scaffold the package

```sh
pn create mikro @acme/devboard --board --chip esp32s3
```

This writes `package.json`, `boards.config.ts`, an empty `pins.ts`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore` and `README.md` into the folder `@acme/devboard/`, for one board at `.`. Pass both the name and `--chip`: without a terminal, a missing one is an error. For a multi-board package, scaffold one board and change the keys and exports as described above.

## Step 2: Edit the files

The sections below show each file in its finished form. Keep what the scaffold writes and add to it; don't remove its scripts or dependencies. Write only the files it doesn't (`sdkconfig.defaults`, the peripheral modules).

### 1. package.json

The scaffold writes the `firmware` export, `./pins`, `./tsconfig`, `files`, the scripts (`prepack` runs the build with the package manager it was created with) and the devDependencies. Set the description, and add an export per peripheral module, the driver packages, and a license.

```json
{
  "name": "@acme/devboard",
  "version": "0.1.0",
  "description": "ACME DevBoard (ESP32-S3, 240x240 ST7789 display)",
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": {"firmware": "./dist-fw/full/firmware.json"},
    "./pins": "./dist/pins.js",
    "./display": "./dist/display.js",
    "./tsconfig": "./tsconfig.json"
  },
  "files": ["dist", "dist-fw", "tsconfig.json"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "prepack": "npm run build && mikro fw build"
  },
  "dependencies": {
    "@acme/drivers": "^0.1.0"
  },
  "peerDependencies": {
    "mikro": "^0.1.0"
  },
  "devDependencies": {
    "@mikrojs/firmware": "^0.1.0",
    "mikro": "^0.1.0",
    "typescript": "^6.0.3"
  }
}
```

Key points:

- `dist-fw` must be in `files`: it is gitignored, and `mikro fw check` fails without it.
- `@mikrojs/firmware` is a direct devDependency: the build resolves it from the package, and pnpm lets a package resolve only its own dependencies.
- `mikro` is a plain required peer for the JS library; driver packages are dependencies. No `peerDependenciesMeta`.
- The package's description becomes the board's description, shown when `mikro flash` asks which board to flash.
- In this monorepo, run `pn create mikro @mikrojs/<board> --board` from `packages/`, so the package lands in `packages/@mikrojs/<board>/` and keeps its scope (the name is the folder, and only a name that starts with `@` keeps one). Then use `"private": true`, `"version": "0.0.0"` and `workspace:*` ranges.

### 2. boards.config.ts

The scaffold writes the chip, with `sdkconfig` and `nativeModules` commented out.

```ts
import {defineBoards} from 'mikro'

export default defineBoards({
  boards: {
    '.': {
      chip: 'esp32s3',
      sdkconfig: 'sdkconfig.defaults',
      // Every native module the board's peripherals need, by the names apps import
      nativeModules: ['@acme/drivers/panel'],
    },
  },
})
```

Leave out `sdkconfig` when the generic firmware's settings are enough. `partitions` names a partition table to use instead of the default one; `project` points at a firmware project of the package's own, for the rare board that needs its own `main` or ESP-IDF components.

### 3. sdkconfig.defaults

Only what the board needs and the generic firmware does not set:

```
CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y
CONFIG_SPIRAM=y
CONFIG_SPIRAM_MODE_OCT=y
```

### 4. pins.ts

The scaffold writes an empty `pins` object; fill it in.

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

Not scaffolded. Add each module to `include` in `tsconfig.build.json` and to `exports`.

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

A native driver imported here must also be in the board's `nativeModules`; `mikro deploy` stops an app that imports a native module the firmware lacks.

### 6. tsconfig.json and tsconfig.build.json

```json
{
  "extends": "mikro/tsconfig/esp32s3-generic"
}
```

The scaffold writes both. Extend the preset for the board's chip. No `include`: paths in an extended config are relative to the board package, not the app. `tsconfig.build.json` extends it, sets `include` to the library's files, `outDir: "dist"`, `declaration: true`, `noEmit: false` and `sourceMap: false` (a map would point at sources that aren't published).

### 7. .gitignore

The scaffold writes it:

```
node_modules
dist
dist-fw
.mikro
```

## Building and testing

1. Build the image (the chip comes from the config):
   ```sh
   pn mikro fw build
   ```
2. `pn mikro fw check` reports anything that would stop the image from flashing or publishing.
3. In an app that depends on the package (a workspace app, or after `npm pack`), run `pn mikro flash`, then deploy a test app that imports from the board package. `mikro flash --build-dir .mikro/build-fw` flashes the build directly.

## Important notes

- `mikro fw build` keeps the generated project in `.mikro/fw` and starts its `sdkconfig` over when the board's settings or chip change.
- A board name has at most 63 characters and the form of a package name, optionally followed by `/<board>`; the build stops otherwise.
- Board modules are bundled and deployed with the app, like any other dependency.
