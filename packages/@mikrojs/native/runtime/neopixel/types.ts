import type {Result} from '../result/types.js'

export interface NeoPixelOptions {
  /** Number of LEDs in the strip */
  count: number
  /** Set to true for RGBW strips (SK6812). Defaults to false (RGB/WS2812). */
  rgbw?: boolean
}

export type NeoPixelError =
  | {name: 'NotActive'}
  | {name: 'IndexOutOfRange'}
  | {name: 'ShowFailed'; message: string}

export declare class NeoPixel {
  constructor(pin: number, options: NeoPixelOptions)
  /** Set a single pixel's color (0–255 per channel) */
  setPixel(index: number, r: number, g: number, b: number, w?: number): Result<void, NeoPixelError>
  /** Set all pixels to the same color */
  fill(r: number, g: number, b: number, w?: number): Result<void, NeoPixelError>
  /** Transmit the pixel buffer to the strip */
  show(): Result<void, NeoPixelError>
  /** Turn off all pixels and transmit */
  clear(): Result<void, NeoPixelError>
  /** Release the RMT channel */
  end(): Result<void, NeoPixelError>
}
