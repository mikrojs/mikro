---
title: NeoPixel
description: Animated RGB LED patterns
---

# NeoPixel

Drive WS2812 / SK6812 RGB LEDs with animated patterns. See the [neopixel API reference](/api/neopixel) for the full type surface.

## Hardware

- Any ESP32 board
- NeoPixel-compatible LEDs (WS2812 or SK6812)
- USB cable

## Code

<CodeWiringTabs>
<template #code>

```ts twoslash
// @noErrors
import {NeoPixel} from 'mikro/neopixel'
import {sleep} from 'mikro/sleep'

const PIN = 8
const NUM_LEDS = 24
const BRIGHTNESS = 1
const PATTERN_DURATION = 8000

const pixels = new NeoPixel(PIN, {count: NUM_LEDS})

// Define your patterns as async functions
// Each pattern animates the pixels for PATTERN_DURATION ms

while (true) {
  // Rainbow cycle
  for (let t = 0; t < PATTERN_DURATION; t += 20) {
    for (let i = 0; i < NUM_LEDS; i++) {
      const hue = ((i / NUM_LEDS) * 360 + t * 0.1) % 360
      pixels.setPixel(i, hsvToRgb(hue, 1, BRIGHTNESS)).orPanic('setPixel failed')
    }
    ;(await pixels.show()).orPanic('show failed')
    await sleep(20)
  }
}
```

</template>
<template #wiring>

<NeoPixelDiagram />

Connect the data-in wire to GPIO 8 (or change `PIN` in the code). Connect VCC to 5V and GND to GND. For more than 8 LEDs, use an external 5V supply instead of the board's USB power.

</template>
</CodeWiringTabs>

The full example in the repository includes multiple patterns: rainbow, comet, breathe, sparkle, and color wipe. Each pattern is a separate module that takes the NeoPixel instance, LED count, brightness, and duration as parameters.

## Key concepts

- **`new NeoPixel(pin, {count})`**: creates a NeoPixel controller on the given GPIO pin.
- **`pixels.setPixel(index, [r, g, b])`**: sets a pixel's color. Returns a [`Result`](/api/result).
- **`pixels.fill([r, g, b])`**: sets all pixels to the same color.
- **`pixels.show()`**: pushes the pixel buffer to the hardware. Returns a `Promise<Result>`.
- **`pixels.clear()`**: turns off all pixels (sets to black).
- **`pixels.end()`**: releases the hardware resources.

All methods that can fail return a [`Result`](/api/result), so you can use `.orPanic()` for quick prototyping or check `.ok` for production code.

## Create project

::: code-group

```sh [pnpm]
pnpm create mikro --template neopixel
```

```sh [npm]
npm create mikro -- --template neopixel
```

```sh [yarn]
yarn create mikro --template neopixel
```

```sh [bun]
bun create mikro --template neopixel
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

The LEDs will cycle through animated patterns, each lasting 8 seconds.

[View source on GitHub](https://github.com/mikrojs/mikro/tree/main/examples/neopixel)

---

_NeoPixel is a registered trademark of [Adafruit Industries](https://www.adafruit.com/trademarks)._
