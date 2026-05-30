import type {NeoPixel} from 'mikro/neopixel'
import {ok} from 'mikro/result'
import {sleep} from 'mikro/sleep'

import {hsv} from '../color.js'

/** Comet: a bright head with a fading tail orbits the ring */
export async function comet(pixels: NeoPixel, numLeds: number, brightness: number, ms: number) {
  const TAIL_LEN = 8
  const end = Date.now() + ms
  let pos = 0
  while (Date.now() < end) {
    const fillResult = pixels.fill(0, 0, 0)
    if (!fillResult.ok) return fillResult
    for (let i = 0; i < TAIL_LEN; i++) {
      const idx = (pos - i + numLeds) % numLeds
      const fade = 1 - i / TAIL_LEN
      const v = fade * fade * brightness
      const [r, g, b] = hsv(200, 1, v)
      const pixelResult = pixels.setPixel(idx, r, g, b)
      if (!pixelResult.ok) return pixelResult
    }
    const showResult = pixels.show()
    if (!showResult.ok) return showResult
    pos = (pos + 1) % numLeds
    await sleep(40)
  }
  return ok(undefined)
}
