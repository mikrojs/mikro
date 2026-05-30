---
title: UART
description: Serial communication with UART loopback
---

# UART

Send and receive serial data over UART. This example uses a loopback wiring (TX connected to RX) to verify that data written on one pin is read back on the other. See the [uart API reference](/api/uart) for the full type surface.

## Hardware

- Any ESP32 board with two available GPIO pins
- One jumper wire connecting TX to RX
- USB cable

## Code

```ts twoslash
import {sleep} from 'mikro/sleep'
import {Uart} from 'mikro/uart'

// UART loopback: connect TX (GPIO 16) to RX (GPIO 17) with a jumper wire
const TX_PIN = 16
const RX_PIN = 17
await sleep(2000)
const uart = new Uart(1, {tx: TX_PIN, rx: RX_PIN, baudRate: 115200})

uart.begin().orPanic('Failed to start UART')

const message = new TextEncoder().encode('Hello from UART!\n')
uart.write(message).orPanic('Failed to write')

const reader = uart.read()

if (!reader.ok) {
  console.error('Failed to start reading: %s', reader.error.name)
} else {
  // Give data a moment to loop back
  await sleep(1000)
  for await (const chunk of reader.value) {
    if (!chunk.ok) {
      console.error('UART read error: %s', chunk.error.name)
      break
    }
    console.log('Received: %s', new TextDecoder().decode(chunk.value))
  }
}

uart.end().orPanic('Failed to stop UART')
console.log('Done!')
```

## Walkthrough

1. **UART instance.** `new Uart(portNumber, options)` creates a UART port. Port `1` is used here (port `0` is typically reserved for the USB console). The `baudRate` must match between sender and receiver.

2. **Lifecycle.** `uart.begin()` initializes the hardware. `uart.end()` releases it. Both return [`Result`](/api/result) and `.orPanic()` provides a clear crash message on failure.

3. **Writing.** `uart.write()` sends a `Uint8Array`. Use `TextEncoder` to convert strings to bytes.

4. **Reading.** `uart.read()` returns an async iterator that yields [`Result<Uint8Array, UartError>`](/api/result) items. Check `.ok` before reading `.value`; a non-ok chunk (e.g. port closed mid-read) is the iterator's terminal signal. Use `TextDecoder` to convert bytes back to strings.

5. **Loopback test.** With TX wired to RX, the message you send is immediately received. This is a simple way to verify UART works before connecting to an actual peripheral.

## Create project

::: code-group

```sh [pnpm]
pnpm create mikrojs my-uart --template uart
```

```sh [npm]
npm create mikrojs -- my-uart --template uart
```

```sh [yarn]
yarn create mikrojs my-uart --template uart
```

```sh [bun]
bun create mikrojs my-uart --template uart
```

:::

## Run it

```sh
cd my-uart
```

::: code-group

```sh [pnpm]
pnpm install
pnpm mikro flash  # only needed once per board
pnpm mikro dev
```

```sh [npm]
npm install
npx mikro flash  # only needed once per board
npx mikro dev
```

```sh [yarn]
yarn install
yarn mikro flash  # only needed once per board
yarn mikro dev
```

```sh [bun]
bun install
bunx mikro flash  # only needed once per board
bunx mikro dev
```

:::

You should see "Hello from UART!" echoed back in the console output.

[View source on GitHub](https://github.com/mikrojs/mikro/tree/main/examples/uart)
