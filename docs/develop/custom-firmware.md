---
title: Custom Firmware
description: Build custom mikrojs firmware without cloning the monorepo
---

# Custom Firmware

You can build custom firmware projects by depending on `@mikrojs/firmware` from npm, without forking or cloning the Mikro.js repository. This is the recommended way to create firmware with custom native modules, board-specific drivers, or modified initialization.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [pnpm](https://pnpm.io/) or npm
- [EIM](https://docs.espressif.com/projects/idf-im-ui/en/latest/) with ESP-IDF >= 6.1

```sh
eim install -i v6.1 -t all -n true
```

## Project structure

```
my-firmware/
├── package.json
├── CMakeLists.txt
└── main/              # optional, see Step 3
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

## Step 3: main.cpp (optional)

This step is optional. If your project has no `main/` directory, `project.cmake` adds the firmware package's default one, which calls `MIK_Main()`. A firmware that just composes existing board and driver packages needs no `main/` at all. Write your own to customize initialization.

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

First activate ESP-IDF in your shell. With [EIM](https://docs.espressif.com/projects/idf-im-ui/en/latest/), run `eim select` and source the activation script it prints:

```sh
eim select
# To activate this environment, run the following command in your terminal:
# source ~/.espressif/tools/activate_idf_v6.1.sh
source ~/.espressif/tools/activate_idf_v6.1.sh
```

Then install and build:

```sh
pnpm install
idf.py set-target esp32c6
idf.py build flash monitor
```

Run `idf.py` from the firmware project directory (the one containing `CMakeLists.txt`). Running it from a parent directory, such as a workspace root, fails with "CMakeLists.txt not found in project directory".

## Version mismatches and the bundled firmware

No configuration is needed to protect a custom build. Firmware built through `project.cmake` reports your firmware project's package.json `name` as its identity when the CLI connects. On a version mismatch between the CLI and the device, the CLI only flashes the firmware bundled with it over a device whose identity matches that bundled build. A device reporting anything else gets an error pointing at rebuilding your own firmware (`idf.py flash`, or `mikro flash --build-dir <your-firmware-build>`) instead of silently reverting your sdkconfig overrides, native modules, and boards.

Plain `mikro flash` refuses for the same reason: it probes the device first, and errors when the device reports custom firmware. To deliberately replace a custom build with the bundled firmware (for example, to hand the device back to a plain app project), run `mikro flash --force`. Flashing a chosen artifact with `--build-dir` or `--from` never probes, and a device too broken to answer the probe is flashed as before, so recovery keeps working.

One caveat: devices running custom firmware built with an older `@mikrojs/firmware` (before identity reporting) report no identity and are treated as running the bundled firmware. Rebuild and reflash once with a current version to get the protection.

::: warning Approve the qjsc build script (pnpm)
The firmware build needs `qjsc`, the QuickJS bytecode compiler, which is built by the postinstall script of `@mikrojs/quickjs`. pnpm does not run dependency build scripts unless they are approved, and the skipped script surfaces later as "qjsc not found" during `idf.py build`. Run `pnpm approve-builds`, select `@mikrojs/quickjs`, and install again. Note that `pnpm rebuild @mikrojs/quickjs` does not fix this when the package is only a transitive dependency.
:::

## How it works

When you run `idf.py build`, the `project.cmake` included in your `CMakeLists.txt`:

1. Validates ESP-IDF >= 6.1
2. Resolves the `mikrojs` component from `@mikrojs/firmware`
3. Scans your `package.json` dependencies for board/driver packages (via their `cmake.js` exports)
4. Sets `EXTRA_COMPONENT_DIRS` to include all discovered components
5. Configures sdkconfig defaults and partition table from the firmware package (overridable with local files)
6. Embeds your project's `package.json` name as the firmware identity the device reports to the CLI

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

The firmware archive must be a `.tar.gz` containing `flasher_args.json` and the binary files (the same format that `idf.py build` produces in the `build/` directory).

## Overriding defaults

- **sdkconfig**: Add a local `sdkconfig.defaults` file. It takes priority over the firmware package defaults.
- **WiFi**: Set `CONFIG_MIKROJS_WIFI=n` in that file to leave the WiFi driver and the `mikro/wifi` module out. This frees about 20 KB of internal RAM for apps that do all their networking over another link, such as a cellular modem. IDF's own `CONFIG_ESP_WIFI_ENABLED` cannot be turned off on WiFi-capable chips.
- **Partition table**: Add a local `partitions.csv` file.
- **main.cpp**: Provide your own `main/` directory with custom initialization.
