import type {BuiltinDefinition} from './types.js'

export const neopixelBuiltin: BuiltinDefinition = {
  source: `
export class NeoPixel {
  constructor(_pin, _numLeds, _bytesPerLed) {}
  setPixel() { return {ok: true} }
  fill() { return {ok: true} }
  show() { return {ok: true} }
  clear() { return {ok: true} }
  end() { return {ok: true} }
}
`,
}
