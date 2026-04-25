import {NeoPixel as NativeNeoPixel} from 'native:neopixel'

import type {Result} from '../result/types.js'
import type {NeoPixelError, NeoPixelOptions} from './types.js'

export class NeoPixel {
  #native: InstanceType<typeof NativeNeoPixel>

  constructor(pin: number, options: NeoPixelOptions) {
    this.#native = new NativeNeoPixel(pin, options.count, options.rgbw ? 4 : 3)
  }

  setPixel(
    index: number,
    r: number,
    g: number,
    b: number,
    w?: number,
  ): Result<void, NeoPixelError> {
    return this.#native.setPixel(index, r, g, b, w ?? 0)
  }

  fill(r: number, g: number, b: number, w?: number): Result<void, NeoPixelError> {
    return this.#native.fill(r, g, b, w ?? 0)
  }

  show(): Result<void, NeoPixelError> {
    return this.#native.show()
  }

  clear(): Result<void, NeoPixelError> {
    return this.#native.clear()
  }

  end(): Result<void, NeoPixelError> {
    return this.#native.end()
  }
}
