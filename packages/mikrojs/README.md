<p align="center">
  <img src="https://mikrojs.dev/logo.svg" width="200" alt="Mikro.js logo">
</p>

<h1 align="center">Mikro.js</h1>

<p align="center">TypeScript-first runtime for microcontrollers with a focus on developer experience and iteration speed.</p>

<p align="center">
  <a href="https://mikrojs.dev">Documentation</a> · <a href="https://mikrojs.dev/getting-started">Getting Started</a> · <a href="https://mikrojs.dev/api/">API Reference</a> · <a href="https://mikrojs.dev/examples/">Examples</a>
</p>

> [!NOTE]
> Mikro.js is in early development. APIs may change.

## Features

- **Instant feedback** — save a file, see it running on your device in seconds
- **Full TypeScript** — type-checked hardware APIs with modern ES support
- **Batteries included** — GPIO, PWM, I2C, SPI, UART, WiFi, fetch, NeoPixel, deep sleep, SNTP, CBOR, schema validation, key-value storage, and more
- **Host simulator** — run and test your code on your computer with `mikro dev --sim`
- **No exceptions** — typed Result errors instead of try/catch
- **Built-in testing** — write tests with familiar describe/it syntax, run on-device or in the simulator

## Quick start

```sh
npm create mikrojs my-app
cd my-app
npm install
npx mikro flash   # once per board
npx mikro dev     # build, deploy, live-reload
```

## Example

```ts
import {digitalWrite, pinMode} from 'mikrojs/pin'
import {sleep} from 'mikrojs/sleep'

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
- **Platform**: ESP-IDF >= 6.0 (ESP32, ESP32-C3, ESP32-S3, ESP32-C6), desktop (macOS, Linux)
- **Modules**: Four-source resolution: virtual modules, native C modules, bytecode builtins, filesystem (LittleFS)
- **Bytecode**: TypeScript bundled with esbuild, compiled to QuickJS bytecode at build time
- **Tooling**: Node.js CLI (Ink/React), Node-API addon for host-side development and simulation

The project has drawn inspiration and borrowed parts of the implementation from [txiki.js](https://github.com/saghul/txiki.js), a small and powerful JavaScript runtime built on QuickJS.

## License

MIT
