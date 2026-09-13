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
import {NeoPixel} from 'mikro/neopixel'
import {sleep} from 'mikro/sleep'

const PIN = 8
const NUM_LEDS = 24

const pixels = NeoPixel(PIN, {count: NUM_LEDS}).orPanic('Failed to set up the LED strip')

// Maps a position from 0 to 255 on the color wheel to [r, g, b]
function wheel(pos: number): [number, number, number] {
  if (pos < 85) return [255 - pos * 3, pos * 3, 0]
  if (pos < 170) return [0, 255 - (pos - 85) * 3, (pos - 85) * 3]
  return [(pos - 170) * 3, 0, 255 - (pos - 170) * 3]
}

// Rainbow cycle
for (let offset = 0; ; offset = (offset + 1) % 256) {
  for (let i = 0; i < NUM_LEDS; i++) {
    const [r, g, b] = wheel((Math.floor((i * 256) / NUM_LEDS) + offset) % 256)
    pixels.setPixel(i, r, g, b).orPanic('setPixel failed')
  }
  pixels.show().orPanic('show failed')
  await sleep(20)
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

- **`NeoPixel(gpio, {count})`**: claims the GPIO pin for the strip's data line and returns a [`Result`](/api/result) with the handle.
- **`pixels.setPixel(index, r, g, b)`**: sets a pixel's color, 0 to 255 per channel. Returns a [`Result`](/api/result).
- **`pixels.fill(r, g, b)`**: sets all pixels to the same color.
- **`pixels.show()`**: pushes the pixel buffer to the hardware. Returns a [`Result`](/api/result).
- **`pixels.clear()`**: turns off all pixels (sets to black).
- **`pixels.end()`**: releases the hardware resources and the GPIO pin.

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
