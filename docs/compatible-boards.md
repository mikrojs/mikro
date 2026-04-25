---
title: Compatible Boards
description: ESP32 development boards that work with Mikro.js
---

# Compatible Boards

Mikro.js works with most ESP32-based development boards. This page lists boards that are known to work and boards that should work based on their specs.

## Requirements

- **Chip**: ESP32, ESP32-S3, ESP32-C3, or ESP32-C6
- **Flash**: At least 4 MB
- **RAM**: At least 300 KB available
- **USB**: USB-C recommended for ease of use

The key limiting factor is RAM: the runtime, your JavaScript application, and all loaded modules must fit in memory. Boards with **PSRAM** give you significantly more room, but it is not required for smaller applications.

## Tested

These boards are actively used during Mikro.js development.

| Board                     | Chip     | Flash | PSRAM | Link                                                                                 |
| ------------------------- | -------- | ----- | ----- | ------------------------------------------------------------------------------------ |
| Seeed Studio XIAO ESP32C3 | ESP32-C3 | 4 MB  | -     | [seeedstudio.com](https://www.seeedstudio.com/Seeed-XIAO-ESP32C3-p-5431.html)        |
| Seeed Studio XIAO ESP32S3 | ESP32-S3 | 8 MB  | 8 MB  | [seeedstudio.com](https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html)              |
| Seeed Studio XIAO ESP32C6 | ESP32-C6 | 4 MB  | -     | [seeedstudio.com](https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32C6-p-5884.html) |

The XIAO ESP32C6 is small, cheap (~$5), has USB-C, and is the primary board Mikro.js is developed and tested against. If you're unsure what to buy, start here.

## Other boards

Any board that meets the [requirements](#requirements) should work, regardless of manufacturer: Adafruit, SparkFun, Waveshare, LILYGO, WeAct, generic DevKit boards, etc. If you try one, [let us know](https://github.com/mikrojs/mikrojs/issues) how it goes.

## Chip notes

- **ESP32-C3**: Single-core RISC-V. Works well but has less RAM than dual-core variants.
- **ESP32-C6**: Adds Wi-Fi 6 and Thread/Zigbee radio alongside BLE.

## Other manufacturers

Any ESP32 board that meets the [requirements](#requirements) should work, regardless of manufacturer: SparkFun, Waveshare, LILYGO, WeAct, generic DevKit boards, etc. If you have a board with a supported chip and at least 4 MB flash, give it a try.
