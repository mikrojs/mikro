---
title: Custom Firmware
description: Build custom mikrojs firmware without cloning the monorepo
---

# Custom Firmware

You can build custom firmware projects by depending on `@mikrojs/firmware` from npm, without forking or cloning the mikrojs repository. This is the recommended way to create firmware with custom native modules, board-specific drivers, or modified initialization.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [pnpm](https://pnpm.io/) or npm
- [EIM](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/index.html) with ESP-IDF >= 6.0.1

```sh
eim install -i v6.0.1 -t all -n true
```

## Project structure

```
my-firmware/
├── package.json
├── CMakeLists.txt
└── main/
    ├── CMakeLists.txt
    └── main.cpp
```

## Step 1: package.json

```json
{
  "name": "my-firmware",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@mikrojs/firmware": "^0.1.0"
  }
}
```

Add board or driver packages as needed (board/driver packages export `cmake.js` and are picked up automatically by `project.cmake`):

```json
{
  "dependencies": {
    "@mikrojs/firmware": "^0.1.0",
    "@mikrojs/your-board": "^0.1.0",
    "@mikrojs/your-driver": "^0.1.0"
  }
}
```

## Step 2: CMakeLists.txt

```cmake
cmake_minimum_required(VERSION 3.22)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)

execute_process(
    COMMAND node ${CMAKE_CURRENT_LIST_DIR}/node_modules/@mikrojs/firmware/resolve.js projectCmakePath
    OUTPUT_VARIABLE _MIK_CMAKE
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
include(${_MIK_CMAKE})

project(my-firmware)
```

The `project.cmake` from `@mikrojs/firmware` handles everything: ESP-IDF version validation, component discovery, sdkconfig defaults, and partition table setup.

## Step 3: main.cpp

For standard firmware (REPL, deploy, config protocols):

```cpp
#include "mikrojs_esp32.h"

extern "C" void app_main(void) {
    MIK_Main();
}
```

`MIK_Main()` sets up NVS, LittleFS, the JS runtime, and enters the event loop with full REPL and deploy support.

For custom initialization, see the [full main.cpp source](https://github.com/mikrojs/mikro/blob/main/packages/%40mikrojs/firmware/components/mikrojs/mik_main.cpp) as a starting point.

`main/CMakeLists.txt`:

```cmake
idf_component_register(SRCS "main.cpp"
    PRIV_REQUIRES spi_flash mikrojs littlefs esp_driver_uart esp_driver_usb_serial_jtag
    INCLUDE_DIRS "")
```

## Step 4: Install and build

```sh
pnpm install
npx idf.py set-target esp32c6
npx idf.py build flash monitor
```

The `idf.py` command is provided by `@mikrojs/firmware` and runs through [EIM](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/index.html), so no manual ESP-IDF activation is needed.

## How it works

When you run `idf.py build`, the `project.cmake` included in your `CMakeLists.txt`:

1. Validates ESP-IDF >= 6.0.1
2. Resolves the `mikrojs` component from `@mikrojs/firmware`
3. Scans your `package.json` dependencies for board/driver packages (via their `cmake.js` exports)
4. Sets `EXTRA_COMPONENT_DIRS` to include all discovered components
5. Configures sdkconfig defaults and partition table from the firmware package (overridable with local files)

If your project has no `main/` directory, the firmware package provides a default one that calls `MIK_Main()`.

## Flashing from external sources

If you publish firmware for others to use, they can flash it without building:

```sh
# From a GitHub repo's latest release
mikro flash --firmware user/my-firmware

# From a specific tag
mikro flash --firmware user/my-firmware@v1.0.0

# From a direct URL
mikro flash --firmware https://example.com/my-firmware.tar.gz
```

The firmware archive should be a `.tar.gz` containing `flasher_args.json` and the binary files (the same format that `idf.py build` produces in the `build/` directory).

## Overriding defaults

- **sdkconfig**: Add a local `sdkconfig.defaults` file. It takes priority over the firmware package defaults.
- **Partition table**: Add a local `partitions.csv` file.
- **main.cpp**: Provide your own `main/` directory with custom initialization.
