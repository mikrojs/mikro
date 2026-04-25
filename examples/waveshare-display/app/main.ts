import {display} from '@mikrojs/waveshare/esp32-s3-knob-touch-lcd-1.8'
import {sleep} from 'mikrojs/sleep'
import {memoryUsage} from 'mikrojs/sys'

const W = display.width
const H = display.height

function rgb(r: number, g: number, b: number): number {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
}

function hsv(h: number, s: number, v: number): number {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = c
    g = x
  } else if (h < 120) {
    r = x
    g = c
  } else if (h < 180) {
    g = c
    b = x
  } else if (h < 240) {
    g = x
    b = c
  } else if (h < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  return rgb(Math.floor((r + m) * 255), Math.floor((g + m) * 255), Math.floor((b + m) * 255))
}

const mem = memoryUsage()
console.log('free heap: %dKB', Math.floor((mem.heapTotal - mem.heapUsed) / 1024))

display.setBacklight(90)

// Animated rainbow bars that smoothly shift hue over time
const barHeight = 20
const barCount = Math.floor(H / barHeight)
let hue = 0

while (true) {
  for (let i = 0; i < barCount; i++) {
    const barHue = (hue + i * (360 / barCount)) % 360
    display.fillRect(0, i * barHeight, W, barHeight, hsv(barHue, 0.9, 0.9))
  }
  hue = (hue + 3) % 360
  await sleep(50)
}
