---
title: Development Guide
description: Contribute drivers, board packages, and firmware to Mikro.js
---

# Development Guide

This section covers building Mikro.js firmware from source, creating driver packages for sensors and peripherals, and defining board packages that bundle drivers with pin configurations.

## What you can contribute

- **Driver packages** (`@mikrojs/driver-xxx`): Native C/C++ modules paired with TypeScript wrappers for sensors, displays, motor controllers, and other peripherals.
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
git clone --recurse-submodules https://github.com/mikrojs/mikrojs.git
cd mikrojs
pnpm install
```

If you already cloned without submodules:

```sh
git submodule update --init --recursive
pnpm install
```

This installs all workspace dependencies and builds the `qjsc` bytecode compiler (used during firmware builds).

## What's next

- [Custom Firmware](./custom-firmware) -- Build and distribute custom firmware from npm packages
- [Building from Source](./building-firmware) -- Set up ESP-IDF and build firmware from the monorepo
- [Creating Drivers](./creating-drivers) -- Build a native driver package for a peripheral
- [Creating Boards](./creating-boards) -- Define a board package with pin maps and sdkconfig
- [Architecture](./architecture) -- How the build system, module registration, and bytecode pipeline work
