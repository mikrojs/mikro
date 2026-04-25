---
title: Comparison
description: How Mikro.js compares to other microcontroller platforms
---

# Comparison

Here's how Mikro.js compares to other options for programming microcontrollers.

## Overview

|                    | Mikro.js          | Arduino       | MicroPython     | CircuitPython   | Espruino   | Moddable (XS)   |
| ------------------ | ----------------- | ------------- | --------------- | --------------- | ---------- | --------------- |
| **Language**       | TypeScript        | C/C++         | Python 3 subset | Python 3 subset | JavaScript | JavaScript      |
| **Type checking**  | Full (TypeScript) | Full (static) | Optional hints  | None            | None       | Experimental TS |
| **Live reload**    | Yes               | No            | No              | Auto-reload     | REPL       | No              |
| **Error handling** | Typed Results     | Manual        | Exceptions      | Exceptions      | Exceptions | Exceptions      |
| **JS engine**      | QuickJS-NG        | N/A           | N/A             | N/A             | Custom     | XS              |
| **ESP32 support**  | Yes               | Yes           | Yes             | Partial         | Yes        | Yes             |
| **Module system**  | ES modules        | Arduino libs  | Python imports  | Python imports  | CommonJS   | ES modules      |

## ECMAScript support

For the JavaScript-based runtimes, here's how their ES spec coverage compares:

|                   | Mikro.js (QuickJS-NG) | Espruino | Moddable (XS) |
| ----------------- | --------------------- | -------- | ------------- |
| **ES2015 (ES6)**  | Full                  | Partial  | Full          |
| **ES2016–ES2020** | Full                  | Minimal  | Full          |
| **ES2021–ES2023** | Full                  | No       | Full          |
| **ES2024**        | Mostly                | No       | Partial       |
| **Modules**       | ES modules            | Custom   | ES modules    |
| **Intl APIs**     | No                    | No       | No            |
| **Async/await**   | Yes                   | Yes      | Yes           |
| **Proxy/Reflect** | Yes                   | No       | Yes           |

Mikro.js uses [QuickJS-NG](https://github.com/quickjs-ng/quickjs), which passes ~98% of language tests and ~82% overall on [test262](https://test262.fyi/#|qjs_ng) (the gap is mostly Intl and Temporal APIs, omitted due to code size constraints).

## vs Arduino (C/C++)

Arduino is one of the most popular microcontroller platforms with a large library ecosystem. The development cycle is edit, compile, flash, test. A simple change can take 30+ seconds to verify.

Mikro.js uses live reload (save and see results in seconds), TypeScript type checking, and automatic memory management. Arduino gives you native performance, lower memory overhead, broad hardware support, and access to a very large library ecosystem.

## vs MicroPython

MicroPython runs a subset of Python 3 on microcontrollers with broad hardware support and a REPL for interactive development.

Mikro.js has full TypeScript type checking (MicroPython's type hints are optional), typed error handling via Results, and live reload over serial. MicroPython supports more hardware (STM32, RP2040, nRF, etc.), has a larger community, more driver libraries, and a mature REPL.

## vs CircuitPython

CircuitPython builds on MicroPython and is focused on beginner-friendliness. Code lives on a USB drive; save a file and it runs immediately.

Mikro.js has TypeScript type checking and typed Results. CircuitPython has 260+ curated Adafruit libraries, drag-and-drop workflow via USB mass storage, excellent beginner documentation, and broad board support (Adafruit, RP2040, nRF).

## vs Espruino

Espruino runs a custom JavaScript engine on microcontrollers. Development is REPL-driven: type code, see it execute immediately.

Mikro.js has TypeScript type checking, ES2024 support via QuickJS-NG, standard ES modules, and typed Results. Espruino has a true interactive REPL, runs on very small devices (128KB flash, 8KB RAM), and has a Bluetooth/wearable focus (Puck.js, Bangle.js).

## vs Moddable SDK (XS)

Moddable provides a full SDK with the XS JavaScript engine, targeting IoT products.

Mikro.js has first-class TypeScript (Moddable has [experimental TypeScript support](https://moddable.com/blog/typescript/)), live reload, and typed Result errors. Moddable has an integrated source-level debugger (xsbug) and a more mature network protocol stack (MQTT, mDNS, BLE).

## vs Embedded Rust, MicroZig, Embedded Swift

These are compiled-to-native languages targeting microcontrollers. They prioritize runtime performance and memory safety over development speed.

**Embedded Rust** has a growing ecosystem for bare-metal and [RTOS](https://en.wikipedia.org/wiki/Real-time_operating_system)-based development with compile-time memory safety, zero-cost abstractions, and no garbage collector.

**MicroZig** brings Zig to microcontrollers with a focus on simplicity and C interop.

**Embedded Swift** brings Swift to bare-metal targets with familiar Apple-ecosystem tooling.

All three produce native binaries with minimal runtime overhead. Mikro.js trades some of that for a faster development loop: live reload and one of the most popular programming languages in the world.
