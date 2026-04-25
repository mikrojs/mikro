# @mikrojs/firmware

ESP32 firmware package for Mikro.js. Provides the ESP-IDF integration, build system, and platform-specific modules (GPIO, WiFi, HTTP, etc.) needed to run Mikro.js on ESP32 chips.

## What's included

- **`project.cmake`** - CMake module that integrates with ESP-IDF. Handles component discovery, SDK config merging, and partition table defaults.
- **`components/mikrojs/`** - ESP-IDF component that compiles the Mikro.js runtime, QuickJS engine, and platform-specific C modules.
- **`idf.py` wrapper** - Runs `idf.py` through `eim run`, so you don't need to manually activate ESP-IDF.
- **Default configs** - `sdkconfig.defaults` and `partitions.csv` for common setups.

## Usage

A custom firmware project depends on this package and includes `project.cmake`:

```
my-firmware/
├── package.json          # depends on @mikrojs/firmware
├── CMakeLists.txt        # include($ENV{MIKROJS_PROJECT_CMAKE})
└── main/
    ├── CMakeLists.txt
    └── main.cpp          # calls MIK_Main()
```

See the [Custom Firmware](https://mikrojs.dev/develop/custom-firmware) docs for details.

## Requirements

- Node.js >= 24
- ESP-IDF >= 6.0 (installed via [EIM](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/index.html))
