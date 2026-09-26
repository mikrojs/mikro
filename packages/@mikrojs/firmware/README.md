# @mikrojs/firmware

ESP32 firmware package for Mikro.js. Provides the ESP-IDF integration, build system, and platform-specific modules (GPIO, WiFi, HTTP, etc.) needed to run Mikro.js on ESP32 chips.

## What's included

- **`MikroFirmwareConfig.cmake`** and **`project.cmake`** - the CMake package that integrates with ESP-IDF. Turns the native modules that the project lists into ESP-IDF components, merges SDK config, and applies partition table defaults.
- **`components/mikrojs/`** - ESP-IDF component that compiles the Mikro.js runtime, QuickJS engine, and platform-specific C modules.
- **Default configs** - `sdkconfig.defaults` and `partitions.csv` for common setups.

## Usage

A custom firmware project depends on this package and finds it with `find_package(MikroFirmware REQUIRED COMPONENTS esp32 NO_DEFAULT_PATH)`. `mikro idf` resolves the package from the project through its `cmake` export condition and passes its folder to CMake (see the docs below for the CMakeLists boilerplate):

```
my-firmware/
├── package.json          # depends on @mikrojs/firmware and mikro
├── CMakeLists.txt        # find_package(MikroFirmware ...)
└── main/                 # optional: omit it and the package's default main
    ├── CMakeLists.txt    # (which calls MIK_Main()) is used automatically
    └── main.cpp
```

See the [Custom Firmware](https://mikrojs.dev/develop/custom-firmware) docs for details.

## Requirements

- Node.js >= 24
- ESP-IDF >= 6.1 (installed via [EIM](https://docs.espressif.com/projects/idf-im-ui/en/latest/))

To build, run `pn mikro idf build` in the project. `mikro idf` passes its arguments to `idf.py`, through EIM when ESP-IDF is not active in the shell, and tells CMake where this package is. Plain `idf.py` does not.
