---
title: Blinky
description: Blink an LED, the "hello world" of microcontrollers
---

# Blinky

The classic first program: blink an LED on and off. Uses the [gpio](/api/gpio) and [sleep](/api/sleep) APIs.

## Hardware

- Any ESP32 board with a built-in LED, or an external LED connected to a GPIO pin
- USB cable

## Code

<CodeWiringTabs>
<template #code>

```ts twoslash
import {DigitalOut} from 'mikro/gpio'
import {sleep} from 'mikro/sleep'
import {memoryUsage} from 'mikro/sys'

const mem = memoryUsage()
console.log('free heap: %dKB', (mem.heapTotal - mem.heapUsed) / 1000)

// GPIO 15 is the built-in LED on XIAO ESP32C6. Replace with your board's LED pin.
const led = DigitalOut(15).orPanic('Failed to configure LED pin')

let level: 0 | 1 = 0
while (true) {
  level = level ? 0 : 1
  console.log(level ? 'HIGH' : 'LOW')

  const mem = memoryUsage()
  console.log('free memory: %dKB', (mem.heapTotal - mem.heapUsed) / 1000)

  led.write(level)

  await sleep(1000)
}
```

</template>
<template #wiring>
<BlinkyDiagram />

Connect the LED's longer leg (anode) to GPIO 15 through a 220-ohm resistor. Connect the shorter leg (cathode) to GND. If your board has a built-in LED, check the board documentation for its GPIO number.

</template>
</CodeWiringTabs>

## Walkthrough

1. **Memory check.** `memoryUsage()` reports heap usage at startup. Useful for spotting leaks over time.

2. **Pin setup.** `DigitalOut(15)` claims GPIO 15 (the LED on XIAO ESP32C6) and configures it as an output. `.orPanic()` crashes with a clear message if this fails (for example on an invalid GPIO number, or a GPIO pin that is already in use).

3. **Main loop.** Switches the pin between `0` and `1` every second.

4. **Async delay.** `await sleep(1000)` pauses for 1 second.

## Create project

::: code-group

```sh [pnpm]
pnpm create mikro --template blinky
```

```sh [npm]
npm create mikro -- --template blinky
```

```sh [yarn]
yarn create mikro --template blinky
```

```sh [bun]
bun create mikro --template blinky
```

:::

## Run it

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

The LED blinks, and the console prints memory usage every second.

[View source on GitHub](https://github.com/mikrojs/mikro/tree/main/examples/blinky)
