---
title: Creating Boards
description: Define a board package with pin maps, drivers, and sdkconfig
---

# Creating Boards

A board package bundles driver dependencies with board-specific pin assignments and configuration. Users select a board by name and get a working setup without wiring knowledge.

Board packages come in two styles depending on their drivers:

1. **Native boards** use drivers with native C code. They need `cmake.js`, ESP-IDF components, and `MIK_REGISTER_BUILTIN`. The board's runtime is compiled to firmware bytecode. Use this for QSPI displays and other peripherals that need direct hardware access.

2. **Pure JS boards** use drivers that are regular JavaScript (via `mikro/spi`, `mikro/i2c`, etc.). No `cmake.js`, no ESP-IDF component. The board is bundled and deployed with the user's app. Use this when the existing core APIs are sufficient.

## What a board package provides

- **Pin map**: Which GPIO connects to what peripheral on this specific board.
- **Pre-configured drivers**: Re-exports driver APIs with pins already filled in.
- **sdkconfig.defaults**: PSRAM settings, flash size, CPU frequency (native boards only).
- **Board metadata**: Chip type, board name, and description declared in `package.json`.

## Package structure (native board)

```
packages/@mikrojs/acme/
  package.json                         # mikro.boards manifest + exports
  cmake.js                             # exports componentPaths array
  tsconfig.json
  boards/
    acme-devboard/                     # one directory per board
      CMakeLists.txt                   # ESP-IDF component
      builtins.cpp                     # MIK_REGISTER_BUILTIN
      sdkconfig.defaults               # board-specific ESP-IDF config
      acme-devboard.ts                 # re-exports drivers with board pins
```

## Package structure (pure JS board)

```
packages/@mikrojs/acme/
  package.json                         # mikro.boards manifest + exports
  tsconfig.json
  src/
    acme-devboard.ts                   # re-exports drivers with board pins
```

No `cmake.js`, no `boards/` directory with CMake files. Just a TypeScript module that imports from pure JS driver packages.

## Step 1: package.json

The `mikro.boards` field declares what boards this package provides:

```json
{
  "name": "@mikrojs/acme",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    "./acme-devboard": "./boards/acme-devboard/acme-devboard.ts",
    "./cmake": "./cmake.js"
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

## Step 2: cmake.js

```js
const path = require('path')
module.exports = {
  componentPath: path.join(__dirname, 'acme_board'),
  sdkconfigDefaultsPath: path.join(__dirname, 'sdkconfig.defaults'),
}
```

The build system reads `sdkconfigDefaultsPath` and merges it with the base sdkconfig.defaults.

## Step 3: sdkconfig.defaults

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

## Step 4: Runtime TypeScript module

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

The board module imports from driver packages and fills in the pin numbers. Users import from the board package and get a ready-to-use API.

## Step 5: board_builtins.cpp

Register the bytecode builtin so the runtime can resolve imports by package name:

```cpp
#include <mikrojs/mikrojs.h>

// Generated during build
#include "gen/acme-devboard.bytecode.h"

MIK_REGISTER_BUILTIN(acme_devboard, "@mikrojs/acme/acme-devboard",
                     qjsc_acme_devboard, qjsc_acme_devboard_size)
```

## Step 6: CMakeLists.txt

```cmake
idf_component_register(
    SRCS "board_builtins.cpp"
    INCLUDE_DIRS "."
    REQUIRES mikrojs driver_bme280 driver_ssd1306
)

execute_process(
    COMMAND node -e "process.stdout.write(require('@mikrojs/native/cmake').cmakePath)"
    OUTPUT_VARIABLE MIKROJS_CMAKE_PATH
)
include(${MIKROJS_CMAKE_PATH})

mikrojs_generate_bytecode(
    RUNTIME_DIR "${CMAKE_CURRENT_LIST_DIR}/../runtime"
    MODULES acme-devboard/acme-devboard
    MODULE_PREFIX "@mikrojs/acme"
    SYMBOL_PREFIX "acme_devboard"
)

mikrojs_force_include_builtins(${COMPONENT_LIB} acme_devboard)

target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
```

Note: `REQUIRES` lists the ESP-IDF component names (directory names of the driver components, e.g., `driver_bme280`). This ensures the drivers are compiled and linked.

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
