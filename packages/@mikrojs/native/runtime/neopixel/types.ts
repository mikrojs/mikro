/* mikro/neopixel, declared here and implemented in C (mik_neopixel.cpp). */

import type {GpioInUse} from '../gpio/types.js'
import type {Result} from '../result/types.js'

export interface NeoPixelOptions {
  /** Number of LEDs in the strip, 1 to 1024 */
  count: number
  /** Set to true for RGBW strips (SK6812). Defaults to false (RGB/WS2812). */
  rgbw?: boolean
}

export type NeoPixelError =
  | GpioInUse
  | {name: 'InvalidGpio'; message: string}
  | {name: 'InvalidParam'; message: string}
  | {name: 'ConfigFailed'; message: string}
  | {name: 'IndexOutOfRange'}
  | {name: 'ShowFailed'; message: string}

/**
 * @public
 */
export interface NeoPixel {
  /** Set a single pixel's color (0–255 per channel) */
  setPixel(index: number, r: number, g: number, b: number, w?: number): Result<void, NeoPixelError>
  /** Set all pixels to the same color */
  fill(r: number, g: number, b: number, w?: number): Result<void, NeoPixelError>
  /** Transmit the pixel buffer to the strip */
  show(): Result<void, NeoPixelError>
  /** Turn off all pixels and transmit */
  clear(): Result<void, NeoPixelError>
  /** Releases the RMT channel and the GPIO pin. Calling it again does nothing. Afterwards the other
   *  methods do nothing and return `ok()`; the first such call prints a warning. */
  end(): void
}

/**
 * Claims a GPIO pin as the data line of a WS2812 or SK6812 LED strip.
 * @public
 */
export declare function NeoPixel(
  gpio: number,
  options: NeoPixelOptions,
): Result<NeoPixel, NeoPixelError>
