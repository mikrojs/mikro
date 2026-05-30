import type {BuiltinDefinition} from './types.js'

export const neopixelBuiltin: BuiltinDefinition = {
  source: `
import {ok} from 'mikro/result'

export class NeoPixel {
  constructor(_pin, _numLeds, _bytesPerLed) {}
  setPixel() { return ok() }
  fill() { return ok() }
  show() { return ok() }
  clear() { return ok() }
  end() { return ok() }
}
`,
}
