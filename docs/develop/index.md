---
title: Development Guide
description: Contribute drivers, board packages, and firmware to Mikro.js
---

# Development Guide

This section covers building Mikro.js firmware from source, writing drivers for sensors and peripherals, shipping C/C++ with a package as a native module, and describing development boards as board packages.

## What you can contribute

- **Drivers**: code for a sensor, display, motor controller or other peripheral. Most are plain JavaScript on the core APIs; one that needs C/C++ is a native module.
- **Native modules**: C/C++ that a package ships, compiled into the firmware and imported by its package specifier.
- **Board packages**: Pin maps, sdkconfig defaults, and pre-configured driver re-exports for specific development boards.
- **Core runtime**: Bug fixes, performance improvements, and new platform APIs in `packages/@mikrojs/native/`.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [pnpm](https://pnpm.io/) >= 10.30
- [direnv](https://direnv.net/) (for ESP-IDF environment management)
- ESP-IDF prerequisites for your platform: see [Espressif's setup guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/linux-macos-setup.html)
- A USB cable and an ESP32 development board (for on-device testing)

## Getting the source

```sh
git clone --recurse-submodules https://github.com/mikrojs/mikro.git
cd mikro
pnpm install
```

If you already cloned without submodules:

```sh
git submodule update --init --recursive
pnpm install
```

This installs all workspace dependencies and builds the `qjsc` bytecode compiler (used during firmware builds).

## What's next

- [Custom Firmware](./custom-firmware): build and distribute custom firmware from npm packages
- [Building from Source](./building-firmware): set up ESP-IDF and build firmware from the monorepo
- [Creating Drivers](./creating-drivers): build a driver package for a peripheral, in pure JS or native
- [Native Modules](./native-modules): ship C/C++ with a package, compiled into the firmware
- [Creating Boards](./creating-boards): define a board package with pin maps and sdkconfig
- [Architecture](./architecture): how the build system, module registration, and bytecode pipeline work
