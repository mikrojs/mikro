---
title: neopixel
description: WS2812 and SK6812 addressable LED control
---

# neopixel

```ts twoslash
import {NeoPixel} from 'mikro/neopixel'
```

Drive WS2812 (RGB) and SK6812 (RGBW) addressable LEDs.

## Usage

```ts twoslash
import {NeoPixel} from 'mikro/neopixel'

const pixels = new NeoPixel(8, {count: 24})

pixels.fill(255, 0, 0).orPanic('fill failed') // all red
pixels.show().orPanic('show failed') // push to hardware

pixels.setPixel(0, 0, 255, 0).orPanic('set failed') // first pixel green
pixels.show().orPanic('show failed')

pixels.clear().orPanic('clear failed') // all off
pixels.end().orPanic('end failed') // release hardware
```

## Constructor

### new NeoPixel(pin, options)

```ts
new NeoPixel(pin: number, options: NeoPixelOptions)
```

**Parameters:**

- `pin`: GPIO pin connected to the data line
- `options`: see [NeoPixelOptions](#neopixeloptions)

## Methods

### pixels.setPixel(index, r, g, b, w?)

```ts
setPixel(index: number, r: number, g: number, b: number, w?: number): Result<void, NeoPixelError>
```

Set a single pixel's color. Values are 0–255 per channel. The `w` parameter is only used with RGBW LEDs.

### pixels.fill(r, g, b, w?)

```ts
fill(r: number, g: number, b: number, w?: number): Result<void, NeoPixelError>
```

Set all pixels to the same color.

### pixels.show()

```ts
show(): Result<void, NeoPixelError>
```

Transmit the pixel buffer to the pixels. Colors set via `setPixel` and `fill` are not visible until `show()` is called.

### pixels.clear()

```ts
clear(): Result<void, NeoPixelError>
```

Turn off all pixels and transmit (equivalent to `fill(0, 0, 0)` + `show()`).

### pixels.end()

```ts
end(): Result<void, NeoPixelError>
```

Release the RMT hardware channel. Call this when done with the LEDs.

## Types

### NeoPixelOptions

```ts
interface NeoPixelOptions {
  count: number // number of LEDs
  rgbw?: boolean // true for SK6812 RGBW LEDs (default: false)
}
```

## Errors

### NeoPixelError

| Variant           | Fields    | Description             |
| ----------------- | --------- | ----------------------- |
| `NotActive`       | —         | Instance has been ended |
| `IndexOutOfRange` | —         | Pixel index >= count    |
| `ShowFailed`      | `message` | Failed to transmit data |

_NeoPixel is a registered trademark of [Adafruit Industries](https://www.adafruit.com/trademarks)._
