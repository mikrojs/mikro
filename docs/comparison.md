---
title: Comparison
description: How Mikro.js compares to other microcontroller platforms
---

# Comparison

Mikro.js trades runtime performance and hardware breadth for type safety and a fast edit-test loop. If your project is tight on RAM, or targets a chip family other than ESP32, one of the platforms below is a better fit.

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

Arduino's development cycle is edit, compile, flash, test, and a one-line change can take 30+ seconds to verify. Mikro.js replaces that with live reload: save the file and the device is running the new code seconds later, with TypeScript checking it on the way.

Arduino compiles to native code with no runtime overhead, runs on far more hardware than ESP32, and has a library for almost every sensor on the market. If your project is mostly combining existing libraries, that ecosystem is worth more than the faster loop.

## vs MicroPython

MicroPython runs a subset of Python 3 on microcontrollers, with a mature REPL and support for chip families Mikro.js does not target: STM32, RP2040, nRF. Its community and driver library are both considerably larger.

The difference that matters day to day is the type system. MicroPython's type hints are optional and unenforced at runtime; Mikro.js checks types at build time and puts expected failures in the signature via `Result`. Pick MicroPython if your board isn't an ESP32, or the driver you need only exists there.

## vs CircuitPython

CircuitPython builds on MicroPython and optimizes for getting started quickly. Code lives on a USB drive: save a file and it runs immediately, with no toolchain to install.

For a first project that is faster to get running than the Mikro.js setup, and the 260+ curated Adafruit libraries mean most sensors work without writing a driver. Mikro.js asks you to install Node and run a CLI, and gives you type checking and typed `Result` errors in return. Which of those weighs more depends on what you're already familiar with: CircuitPython has less to learn if you know Python, Mikro.js if you know TypeScript.

## vs Espruino

Espruino runs a custom JavaScript engine on microcontrollers. Development is REPL-driven: type code, see it execute immediately.

Espruino runs on much smaller hardware than Mikro.js supports: down to 128 KB flash and 8 KB RAM, including Bluetooth and wearable boards like Puck.js and Bangle.js. Working at the prompt also means no build step between making a change and seeing it run.

Mikro.js requires an ESP32 and a build step on your computer. In exchange you get ES2024 via QuickJS-NG, standard ES modules, TypeScript checking, and typed `Result` errors, against Espruino's older custom dialect.

## vs Moddable SDK (XS)

Moddable provides a full SDK with the XS JavaScript engine, targeting shipping IoT products.

It is the more complete product toolchain: xsbug is a source-level debugger with breakpoints and inspection, which Mikro.js has no equivalent for, and the network stack covers MQTT and mDNS out of the box. Mikro.js offers first-class TypeScript against Moddable's [experimental support](https://moddable.com/blog/typescript/), live reload, and typed `Result` errors. For a product going to manufacturing, the debugger alone may be reason enough to choose Moddable.

## vs Embedded Rust, MicroZig, Embedded Swift

These are compiled-to-native languages targeting microcontrollers. They prioritize runtime performance and memory safety over development speed.

**Embedded Rust** has a growing ecosystem for bare-metal and [RTOS](https://en.wikipedia.org/wiki/Real-time_operating_system)-based development with compile-time memory safety, zero-cost abstractions, and no garbage collector.

**MicroZig** brings Zig to microcontrollers with a focus on simplicity and C interop.

**Embedded Swift** brings Swift to bare-metal targets with familiar Apple-ecosystem tooling.

All three produce native binaries with minimal runtime overhead, and all three require learning a language most web and app developers do not already know. Mikro.js gives up the native performance in exchange for a shorter edit-test loop and a familiar language.
