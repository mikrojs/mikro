---
title: API Reference
description: Mikro.js module API reference
---

# API Reference

Mikro.js provides hardware and system APIs as ES modules. Import them by name:

```ts twoslash
import {pinMode, digitalWrite} from 'mikro/pin'
import {wifi} from 'mikro/wifi'
import {request} from 'mikro/http/request'
```

## Conventions

**Result-based errors.** Functions that can fail return a `Result<T, E>` instead of throwing. Check `.ok` to narrow the type, or call `.orPanic()` when failure is unrecoverable. See the [Error Handling](/error-handling) guide for details.

**Async operations.** Network operations (`wifi.connect`, `request`, `wifi.scan`) return `Promise<Result<T, E>>`. Use `await` and then check the result.

## Modules

| Module                            | Description                                      |
| --------------------------------- | ------------------------------------------------ |
| [env](/api/env)                   | Environment variables: `require`, `get`, `has`   |
| [result](/api/result)             | `Result` type, `ok()`, `err()`, `matchError()`   |
| [schema](/api/schema)             | Runtime type validation with type inference      |
| [pin](/api/pin)                   | GPIO: digital read/write, analog read            |
| [pwm](/api/pwm)                   | Pulse-width modulation                           |
| [neopixel](/api/neopixel)         | WS2812 / SK6812 addressable LEDs                 |
| [i2c](/api/i2c)                   | I2C bus communication                            |
| [spi](/api/spi)                   | SPI bus communication                            |
| [uart](/api/uart)                 | UART serial communication                        |
| [wifi](/api/wifi)                 | WiFi station and access point                    |
| [ble](/api/ble)                   | BLE broadcaster and GATT peripheral              |
| [http/request](/api/http-request) | HTTP client                                      |
| [udp](/api/udp)                   | UDP datagram sockets (IPv4 and IPv6)             |
| [sleep](/api/sleep)               | Delays, deep sleep, light sleep, wakeup sources  |
| [sntp](/api/sntp)                 | Network time synchronization                     |
| [kv](/api/kv)                     | Key-value storage (RTC memory + NVS flash)       |
| [fs](/api/fs)                     | Filesystem I/O with streaming reads              |
| [cbor](/api/cbor)                 | CBOR binary encoding and decoding                |
| [sys](/api/sys)                   | Memory, uptime, GC, restart, environment         |
| [test](/api/test)                 | On-device test framework: describe, test, assert |
