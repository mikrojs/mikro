---
title: Compatible Boards
description: ESP32 development boards that work with Mikro.js
---

# Compatible Boards

## Requirements

- **Chip**: one of the chips listed under [Chip support](#chip-support)
- **Flash**: at least 4 MB

RAM is determined by the chip and module: 384-520 KB of internal SRAM, shared by the runtime, Wi-Fi/BLE stacks, your app, and every loaded module. PSRAM variants (ESP32-S3, ESP32-C5, ESP32 WROVER) add external SPI memory in the same package, which lets larger apps use memory beyond the SRAM budget.

## Chip support

| Chip     | Notes                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESP32‑C6 | **Recommended.** Primary development chip. Wi-Fi 6, BLE 5, Thread/Zigbee.                                                                                                               |
| ESP32‑S3 | **Recommended.** PSRAM variants fit larger apps.                                                                                                                                        |
| ESP32‑C5 | **Recommended.** Dual-band Wi-Fi 6 and BLE 5. Requires PSRAM for the standard mikrojs configuration (Wi-Fi + BLE concurrently); 5 GHz needs [`wifi.country`](/config#wifi-country) set. |
| ESP32    | **Supported.** Prefer WROVER variants (4-8 MB PSRAM) over WROOM.                                                                                                                        |
| ESP32‑C3 | **Limited support.** Good fit for GPIO, timers, sensors, and BLE. Not enough RAM for HTTPS or memory intensive applications.                                                            |

## Tested

| Board                     | Chip     | Flash | PSRAM | Link                                                                                  |
| ------------------------- | -------- | ----- | ----- | ------------------------------------------------------------------------------------- |
| Seeed Studio XIAO ESP32C6 | ESP32‑C6 | 4 MB  | -     | [seeedstudio.com](https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32C6-p-5884.html)  |
| Seeed Studio XIAO ESP32S3 | ESP32‑S3 | 8 MB  | 8 MB  | [seeedstudio.com](https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html)               |
| Seeed Studio XIAO ESP32C5 | ESP32‑C5 | 8 MB  | 8 MB  | [seeedstudio.com](https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32-C5-p-6573.html) |
| Seeed Studio XIAO ESP32C3 | ESP32‑C3 | 4 MB  | -     | [seeedstudio.com](https://www.seeedstudio.com/Seeed-XIAO-ESP32C3-p-5431.html)         |

## Other boards

Any board with a supported chip and at least 4 MB flash should work, regardless of manufacturer: Adafruit, SparkFun, Waveshare, LILYGO, WeAct, generic DevKits. If you try one, [let us know](https://github.com/mikrojs/mikrojs/issues).
