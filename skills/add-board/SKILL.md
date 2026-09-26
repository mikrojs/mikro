---
name: add-board
description: Scaffold a mikrojs board package for a development board. Use this skill whenever the user wants to add support for a specific ESP32 development board, create a board definition with pin maps, configure sdkconfig defaults for a board, or set up pre-configured driver re-exports. Also trigger when the user mentions a specific board by name (e.g. "LilyGo T-Display", "Waveshare", "Seeed XIAO"), wants to define a board package, or asks how to make mikrojs work with their board. Even partial requests like "I have this ESP32-S3 board with a display" should trigger this skill.
---

# Create a mikrojs Board Package

Generate all files for a new board package that provides pin maps, sdkconfig defaults, and pre-configured driver re-exports for a specific development board.

When this skill triggers, gather the required information from the user, then generate all files listed below. The repo's `docs/develop/creating-boards.md` describes the package (pin maps, sdkconfig, driver re-exports). If the user has a demo/example code or schematic for the board, read it to extract pin mappings and hardware details. After generating files, guide the user through building and testing.

## What you need from the user

1. **Board name** (e.g. `xiao-esp32c6`)
2. **Vendor/package name** (e.g. `@mikrojs/some-vendor` for a vendor with multiple boards, or `@mikrojs/my-board` for a single board)
3. **Chip** (e.g. `esp32s3`, `esp32c6`)
4. **Pin map** (GPIO assignments for the board's peripherals)
5. **What drivers the board needs** (e.g. display driver, sensor driver)
6. **Any special sdkconfig** (PSRAM, flash size, CPU frequency)

## Package structure to generate

A board package is JavaScript: it is bundled and deployed with the user's app. Drivers that need C or C++ are native modules (see the `add-driver` skill), and firmware for the board lists them in `MIKROJS_NATIVE_MODULES`.

A board package can contain multiple boards. Each board gets its own directory:

```
packages/@mikrojs/{vendor}/
  package.json                            # mikro.boards manifest + exports
  tsconfig.json
  boards/
    {board-name}/                          # one directory per board
      sdkconfig.defaults                  # board-specific ESP-IDF config
      {board-name}.ts                     # re-exports drivers with pin config
```

## Files to generate

### 1. package.json

```json
{
  "name": "@mikrojs/{vendor}",
  "version": "0.0.0",
  "private": true,
  "description": "{vendor} board definitions for mikrojs",
  "license": "MIT",
  "type": "module",
  "exports": {
    "./{board-name}": "./boards/{board-name}/{board-name}.ts"
  },
  "engines": {
    "mikro": ">=0.0.0"
  },
  "dependencies": {
    "@mikrojs/driver-{driver}": "workspace:*"
  },
  "mikro": {
    "boards": {
      "./{board-name}": {
        "chip": "{chip}",
        "runtime": "./boards/{board-name}/{board-name}.ts",
        "sdkconfig": "./boards/{board-name}/sdkconfig.defaults",
        "description": "{description}"
      }
    }
  }
}
```

Key points:

- The `mikro.boards` keys are subpath exports (prefixed with `./`), tying the board declaration to the package's export map.
- `runtime` points to the TypeScript module that apps import; it deploys with the app.
- `sdkconfig` points to the board-specific ESP-IDF config defaults.
- `engines.mikro` declares the minimum firmware version.
- Only driver packages go in `dependencies`. Build-time deps (`@mikrojs/native`, `@mikrojs/quickjs`) are NOT needed.

### 2. tsconfig.json

```json
{
  "extends": "../../../tsconfig.json",
  "include": ["./boards/**/*.ts"],
  "compilerOptions": {
    "types": [],
    "noEmit": true,
    "moduleDetection": "auto",
    "customConditions": ["development"]
  }
}
```

### 3. Per-board sdkconfig.defaults

Board-specific ESP-IDF settings. Common options:

```
CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y
CONFIG_SPIRAM=y
CONFIG_SPIRAM_MODE_OCT=y
CONFIG_SPIRAM_SPEED_80M=y
CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240=y
```

### 4. Per-board runtime TypeScript ({board-name}.ts)

Re-exports drivers with board-specific pin configuration:

```typescript
import {createDisplay} from '@mikrojs/driver-{driver}'

export const pinMap = {
  // GPIO pin assignments for this board
} as const

// orPanic keeps the driver's error as the panic's cause, so the crash
// report shows what actually failed
export const display = createDisplay({
  // Board-specific configuration (pins, dimensions, etc.)
}).orPanic('display init failed')
```

## Adding a second board to an existing package

1. Create a new directory under `boards/`
2. Add `sdkconfig.defaults` and `{name}.ts`
3. Add the export and `mikro.boards` entry to `package.json`
4. If the new board needs different drivers, add them to `dependencies`

## Building and testing

1. Add the board package to the firmware's `package.json` dependencies
2. `pnpm install`
3. Build with the board selected:
   ```sh
   cd esp32
   rm sdkconfig
   idf.py set-target {chip}
   MIKROJS_BOARD={board-name} idf.py build flash monitor
   ```
4. Deploy a test app that imports from the board package

## Important notes

- The `sdkconfig.defaults` is only applied when `sdkconfig` doesn't exist. Delete `sdkconfig` and re-run `set-target` after changing defaults.
- The board's TypeScript is bundled and deployed with the app, like any other package. Users import it by the package's export name.
