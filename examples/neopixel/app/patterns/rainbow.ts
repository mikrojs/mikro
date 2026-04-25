import type {NeoPixel} from 'mikrojs/neopixel'
import {ok} from 'mikrojs/result'
import {sleep} from 'mikrojs/sleep'

import {hsv} from '../color.js'

/** Rainbow: rotate a full spectrum around the ring */
export async function rainbow(pixels: NeoPixel, numLeds: number, brightness: number, ms: number) {
  const end = Date.now() + ms
  let offset = 0
  while (Date.now() < end) {
    for (let i = 0; i < numLeds; i++) {
      const hue = ((i * 360) / numLeds + offset) % 360
      const [r, g, b] = hsv(hue, 1, brightness)
      const pixelResult = pixels.setPixel(i, r, g, b)
      if (!pixelResult.ok) return pixelResult
    }
    const showResult = pixels.show()
    if (!showResult.ok) return showResult
    offset = (offset + 5) % 360
    await sleep(30)
  }
  return ok()
}
