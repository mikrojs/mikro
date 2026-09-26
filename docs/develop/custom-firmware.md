---
title: Custom Firmware
description: Build Mikro.js firmware with native modules, different settings or custom startup code
---

# Custom Firmware

Build custom firmware when the official Mikro.js firmware lacks something an app needs: a native module, different ESP-IDF settings, a bigger flash chip, or custom startup code. A firmware project is a small npm package, and you don't need the Mikro.js repository.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [pnpm](https://pnpm.io/installation) or npm
- ESP-IDF >= 6.1, installed with [EIM](https://docs.espressif.com/projects/idf-im-ui/en/latest/):

  ```sh
  eim install -i v6.1 -t all -n true
  ```

## Create a project

`package.json` depends on `@mikrojs/firmware`, on `mikro` for the `mikro idf` command, and on the packages whose native modules you want. `@mikrojs/firmware` has to be a direct dependency: the build runs its `mikro-fw` command through `npx`, which finds only the commands of the project's own dependencies.

```json
{
  "name": "my-firmware",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@mikrojs/firmware": "^0.1.0",
    "@my-scope/epaper": "^0.1.0",
    "mikro": "^0.1.0"
  }
}
```

`CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.22)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# Ask @mikrojs/firmware for the path of its project.cmake
execute_process(
    COMMAND npx --no --package=@mikrojs/firmware -- mikro-fw cmake-path esp32
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
    OUTPUT_VARIABLE _MIK_CMAKE_PATH
    OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY
)
# The native modules to compile in, by the names that apps import
set(MIKROJS_NATIVE_MODULES "@my-scope/epaper/panel")

include(${_MIK_CMAKE_PATH})

project(my-firmware)
```

Separate several native modules with `;`. The build stops if an entry is not an installed [native module](./native-modules). Without `MIKROJS_NATIVE_MODULES`, the build is the official Mikro.js firmware with the project's settings.

An app can be its own firmware project: add `@mikrojs/firmware` to the app's dependencies, and put `CMakeLists.txt` next to its `package.json`. [`examples/chip-temperature`](https://github.com/mikrojs/mikro/tree/main/examples/chip-temperature) is set up this way; `pn create mikro --firmware` scaffolds one. ESP-IDF writes `sdkconfig`, `managed_components/` and `dependencies.lock` into the project folder, and the build into `.mikro/` (`build/` with plain `idf.py`), so add them to `.gitignore`.

## Build and flash

In the project folder, install the dependencies, set the chip, and build:

```sh
pn install
pn mikro idf set-target esp32c6
pn mikro idf build flash monitor
```

[`mikro idf`](/cli#mikro-idf) passes its arguments to ESP-IDF's `idf.py`. When ESP-IDF is not active in the shell, it runs `idf.py` through EIM, which activates ESP-IDF first. Plain `idf.py` works too, in a shell where ESP-IDF is active (`eim select` prints the script to source).

::: tip The build says "qjsc not found"
pnpm skipped the build script of `@mikrojs/quickjs`, which builds the QuickJS bytecode compiler. Run `pnpm approve-builds`, select `@mikrojs/quickjs`, and install again.
:::

## Change ESP-IDF settings

Put the settings in a `sdkconfig.defaults` file in the project. They override the firmware package's defaults. ESP-IDF reads the file only when it creates `sdkconfig`, so after you change it, delete `sdkconfig` and run `mikro idf set-target` again.

For example, an app that does all its networking over a cellular modem can leave WiFi out, which frees about 20 KB of internal RAM:

```ini
CONFIG_MIKROJS_WIFI=n
```

## Use a bigger flash chip

The official firmware's partition table is for 4 MB of flash. For a bigger chip, set its size in `sdkconfig.defaults`, and add a `partitions.csv` that gives the extra space to `user`, the partition that holds the app and its files. For 8 MB:

```ini
CONFIG_ESPTOOLPY_FLASHSIZE_8MB=y
CONFIG_ESPTOOLPY_FLASHSIZE="8MB"
```

```csv
# Name,   Type, SubType, Offset,  Size, Flags
nvs,      data, nvs,     0x9000,  0x6000,
phy_init, data, phy,     0xf000,  0x1000,
factory,  app,  factory, 0x10000, 0x280000,
user,     data, littlefs,      ,  0x570000,
```

For 16 MB, use `CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y`, `CONFIG_ESPTOOLPY_FLASHSIZE="16MB"` and a `user` size of `0xD70000`. Keep the names and types of `user` and `factory`: the firmware looks the filesystem up by the name `user`.

::: warning Shrinking the user partition reformats it
If the new `user` partition is smaller than the one on the device, the device reformats it on the next boot, and you need to deploy the app again. `storageUsage().total` shows the size on the device.
:::

Flash the new table over USB with `pn mikro idf flash`. On its first boot, the device grows the filesystem to fill the new `user` partition and keeps any existing files.

## Custom startup code

The firmware starts with `MIK_Main()`, which sets up NVS, the filesystem and the JavaScript runtime, and runs the REPL and the deploy protocol. To run code before it, add a `main/` folder:

```cpp
// main/main.cpp
#include "mikrojs_esp32.h"

extern "C" void app_main(void) {
    // Setup code here
    MIK_Main();
}
```

```cmake
# main/CMakeLists.txt
idf_component_register(SRCS "main.cpp"
    PRIV_REQUIRES spi_flash mikrojs littlefs esp_driver_uart esp_driver_usb_serial_jtag
    INCLUDE_DIRS "")
```

To change what `MIK_Main()` itself does, start from [its source](https://github.com/mikrojs/mikro/blob/main/packages/%40mikrojs/firmware/components/mikrojs/mik_main.cpp).

## Custom firmware and the CLI

The CLI comes with the official Mikro.js firmware, but it never flashes that over custom firmware unless you ask it to. After a CLI upgrade, it asks you to rebuild and flash the custom firmware instead. To switch a device back to the official Mikro.js firmware, run `mikro flash --force`.

## Share a build

Others can flash the firmware without building it. In the project folder, build the firmware and pack it:

```sh
pn mikro fw pack
```

This writes `mikrojs-firmware-esp32c6.tar.gz`, named after the chip, to the current folder. Attach it to a GitHub release: the name lets the CLI pick the right archive from a release with builds for several chips. To flash it:

```sh
mikro flash --from my-org/my-firmware          # the latest release
mikro flash --from my-org/my-firmware@v1.0.0   # a given release
mikro flash --from https://example.com/mikrojs-firmware-esp32c6.tar.gz
```
