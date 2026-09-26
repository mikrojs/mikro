---
title: Creating Boards
description: Define a board package with pin maps, drivers, and sdkconfig
---

# Creating Boards

A board package bundles driver dependencies with board-specific pin assignments and configuration. Users select a board by name and get a working setup without wiring knowledge.

A board package is JavaScript: it is bundled and deployed with the user's app. Drivers that need C or C++ are [native modules](./native-modules), and a firmware for the board lists them in `MIKROJS_NATIVE_MODULES` (see [Custom Firmware](./custom-firmware)).

## What a board package provides

- **Pin map**: Which GPIO connects to what peripheral on this specific board.
- **Pre-configured drivers**: Re-exports driver APIs with pins already filled in.
- **sdkconfig.defaults**: PSRAM settings, flash size, CPU frequency.
- **Board metadata**: Chip type, board name, and description declared in `package.json`.

## Package structure

```
packages/@mikrojs/acme/
  package.json                         # mikro.boards manifest + exports
  tsconfig.json
  src/
    acme-devboard.ts                   # re-exports drivers with board pins
```

## Step 1: package.json

The `mikro.boards` field declares what boards this package provides:

```json
{
  "name": "@mikrojs/acme",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    "./acme-devboard": "./boards/acme-devboard/acme-devboard.ts"
  },
  "mikro": {
    "boards": {
      "./acme-devboard": {
        "chip": "esp32c6",
        "runtime": "./boards/acme-devboard/acme-devboard.ts",
        "sdkconfig": "./boards/acme-devboard/sdkconfig.defaults",
        "description": "ACME DevBoard with BME280 and SSD1306 display"
      }
    }
  },
  "dependencies": {
    "@mikrojs/driver-bme280": "workspace:*",
    "@mikrojs/driver-ssd1306": "workspace:*"
  }
}
```

The keys in `mikro.boards` are subpath exports (prefixed with `./`). This ties the board declaration directly to the package's export map, preventing drift. The board name (without `./`) is what users pass to `MIKROJS_BOARD` and what appears in `sys.board().name`.

## Step 2: sdkconfig.defaults

Board-specific ESP-IDF configuration. Common settings include PSRAM, flash size, and CPU frequency:

```ini
# PSRAM (if the board has it)
CONFIG_SPIRAM=y
CONFIG_SPIRAM_MODE_OCT=y
CONFIG_SPIRAM_SPEED_80M=y

# Flash
CONFIG_ESPTOOLPY_FLASHSIZE_8MB=y

# CPU
CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_160=y
```

These are merged with the project's base `sdkconfig.defaults`. Board-specific values override the base.

## Step 3: Runtime TypeScript module

`runtime/acme-devboard/acme-devboard.ts`:

```ts
import {readSensor} from '@mikrojs/driver-bme280/bme280'
import {createDisplay} from '@mikrojs/driver-ssd1306/ssd1306'
import type {Result} from 'mikro/result'

// Board-specific pin assignments
const I2C_SDA = 6
const I2C_SCL = 7
const I2C_BUS = 0
const BME280_ADDR = 0x76
const DISPLAY_ADDR = 0x3c
const DISPLAY_WIDTH = 128
const DISPLAY_HEIGHT = 64

export function readTemperature() {
  return readSensor(I2C_BUS, BME280_ADDR)
}

export function getDisplay() {
  return createDisplay({
    bus: I2C_BUS,
    address: DISPLAY_ADDR,
    width: DISPLAY_WIDTH,
    height: DISPLAY_HEIGHT,
    sda: I2C_SDA,
    scl: I2C_SCL,
  })
}
```

The board module imports from driver packages and fills in the GPIO numbers. Users import from the board package and get a ready-to-use API.

## Building with a board

After adding the board package to `esp32/package.json`:

```sh
cd esp32
pnpm install
rm sdkconfig
idf.py set-target esp32c6
MIKROJS_BOARD=acme-devboard idf.py build flash monitor
```

## User code with a board

Once the firmware is flashed with a board, user code can import directly from the board package:

```ts
import {readTemperature, getDisplay} from '@mikrojs/acme/acme-devboard'

const result = readTemperature()
if (result.ok) {
  console.log(`Temperature: ${result.value.temperature}C`)
}
```

## Submitting a board package

Open a pull request to the repository. Add the board to the CI build matrix so it stays tested. Include:

- The complete package under `packages/@mikrojs/`
- A `board.json` with pin map documentation
- Any required driver packages if they don't exist yet
