import {NeoPixel} from 'mikro/neopixel'

import {breathe} from './patterns/breathe.js'
import {colorWipe} from './patterns/color-wipe.js'
import {comet} from './patterns/comet.js'
import {rainbow} from './patterns/rainbow.js'
import {sparkle} from './patterns/sparkle.js'

const PIN = 8
const NUM_LEDS = 24
const BRIGHTNESS = 1
const PATTERN_DURATION = 8000

const pixels = new NeoPixel(PIN, {count: NUM_LEDS})

const patterns = [rainbow, comet, breathe, sparkle, colorWipe]

while (true) {
  for (const pattern of patterns) {
    ;(await pattern(pixels, NUM_LEDS, BRIGHTNESS, PATTERN_DURATION)).orPanic(
      `NeoPixel pattern ${pattern.name} failed`,
    )
  }
}
