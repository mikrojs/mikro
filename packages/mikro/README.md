<p align="center">
  <img src="https://mikrojs.dev/logo.svg" width="200" alt="Mikro.js logo">
</p>

<h1 align="center">Mikro.js</h1>

<p align="center">TypeScript-first runtime for microcontrollers with a focus on developer experience and iteration speed.</p>

<p align="center">
  <a href="https://mikrojs.dev">Documentation</a> · <a href="https://mikrojs.dev/getting-started">Getting Started</a> · <a href="https://mikrojs.dev/api/">API Reference</a> · <a href="https://mikrojs.dev/examples/">Examples</a>
</p>

<div align="center">

[![Open on npmx.dev](https://npmx.dev/api/registry/badge/name/mikro)](https://npmx.dev/package/mikro)
[![Open on npmx.dev](https://npmx.dev/api/registry/badge/version/mikro)](https://npmx.dev/package/mikro)
[![Open on npmx.dev](https://npmx.dev/api/registry/badge/updated/mikro)](https://npmx.dev/package/mikro)

</div>

> [!NOTE]
> Mikro.js is in early development. Expect APIs to change.

## Features

- **Fast feedback loop**: interactive dev console with watch mode and incremental builds that deploy to your device in a few seconds
- **Full TypeScript**: near-complete ES2024 support, type-checked hardware APIs, and editor autocomplete
- **Batteries included**: GPIO, PWM, I2C, SPI, UART, WiFi, HTTP, UDP, NeoPixel, deep sleep, SNTP, CBOR, schema validation, key-value storage, and more
- **Host simulator**: run your code on your computer with `mikro sim dev`. No microcontroller needed
- **No exceptions**: typed Result errors instead of try/catch. Every failure is visible in the type signature
- **Built-in testing**: test suites with resource leak detection and more. Run in the simulator or on a real device

## Quickstart

```sh
npm create mikro
```

## Example

```ts
import {digitalWrite, pinMode} from 'mikro/pin'
import {sleep} from 'mikro/sleep'

const LED = 20

pinMode(LED, 'OUTPUT').orPanic('Failed to set pin mode')

while (true) {
  digitalWrite(LED, 1)
  await sleep(500)
  digitalWrite(LED, 0)
  await sleep(500)
}
```

## Overview

The core runtime is a standalone C++ library with no ESP-IDF dependencies, making it portable across platforms.

- **Engine**: [QuickJS-NG](https://github.com/quickjs-ng/quickjs) ([near-complete ES2024 coverage](https://test262.fyi/#|qjs_ng))
- **Runtime**: Standalone C++ library with cooperative, single-threaded event loop
- **Platform**: ESP-IDF >= 6.0.1 (ESP32, ESP32-C3, ESP32-S3, ESP32-C5, ESP32-C6), desktop (macOS, Linux)
- **Modules**: Four-source resolution: virtual modules, native C modules, bytecode builtins, filesystem (LittleFS)
- **Bytecode**: TypeScript bundled with esbuild, compiled to QuickJS bytecode at build time
- **Tooling**: Node.js CLI (Ink/React), Node-API addon for host-side development and simulation

## Acknowledgements

Mikro.js has drawn heavy inspiration from [txiki.js](https://github.com/saghul/txiki.js), a small JavaScript runtime built on QuickJS.

Thanks to Felix Wieland ([@flexwie](https://github.com/flexwie)) for generously donating the `mikro` package name on npm.

## License

MIT
