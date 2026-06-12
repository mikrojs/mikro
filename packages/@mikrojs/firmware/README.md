# @mikrojs/firmware

ESP32 firmware package for Mikro.js. Provides the ESP-IDF integration, build system, and platform-specific modules (GPIO, WiFi, HTTP, etc.) needed to run Mikro.js on ESP32 chips.

## What's included

- **`project.cmake`** - CMake module that integrates with ESP-IDF. Handles component discovery, SDK config merging, and partition table defaults.
- **`components/mikrojs/`** - ESP-IDF component that compiles the Mikro.js runtime, QuickJS engine, and platform-specific C modules.
- **Default configs** - `sdkconfig.defaults` and `partitions.csv` for common setups.

## Usage

A custom firmware project depends on this package and includes `project.cmake` (resolved via `resolve.js`, see the docs below for the CMakeLists boilerplate):

```
my-firmware/
├── package.json          # depends on @mikrojs/firmware
├── CMakeLists.txt        # resolves and includes project.cmake via resolve.js
└── main/                 # optional: omit it and the package's default main
    ├── CMakeLists.txt    # (which calls MIK_Main()) is used automatically
    └── main.cpp
```

See the [Custom Firmware](https://mikrojs.dev/develop/custom-firmware) docs for details.

## Requirements

- Node.js >= 24
- ESP-IDF >= 6.0.1 (installed via [EIM](https://docs.espressif.com/projects/idf-im-ui/en/latest/))

To build, activate ESP-IDF in your shell first: run `eim select` and source the activation script it prints, then use `idf.py` as usual.
