import {digitalWrite, pinMode} from 'mikrojs/pin'
import {err, ok, type Result} from 'mikrojs/result'
import {sleep} from 'mikrojs/sleep'
import {Spi} from 'mikrojs/spi'

import type {Display, DisplayConfig} from './types.js'

export type {Display, DisplayConfig} from './types.js'

// ST7789 commands
const CMD_SWRESET = 0x01
const CMD_SLPOUT = 0x11
const CMD_COLMOD = 0x3a
const CMD_MADCTL = 0x36
const CMD_CASET = 0x2a
const CMD_RASET = 0x2b
const CMD_RAMWR = 0x2c
const CMD_INVON = 0x21
const CMD_NORON = 0x13
const CMD_DISPON = 0x29

// MADCTL flags
const MADCTL_MX = 0x40
const MADCTL_MV = 0x20
const MADCTL_RGB = 0x00

export async function createDisplay(
  config: DisplayConfig,
): Promise<Result<Display, {type: 'InitFailed'; message: string}>> {
  const {width, height, spiHost, pins, freq = 40_000_000, offsetX = 0, offsetY = 0} = config

  const spi = new Spi(spiHost, {
    clk: pins.sclk,
    mosi: pins.mosi,
    cs: pins.cs,
    freq,
    mode: 0,
  })

  const beginResult = spi.begin()
  if (!beginResult.ok) {
    return err({type: 'InitFailed' as const, message: `SPI init failed: ${beginResult.error.name}`})
  }

  // Configure control pins
  const pinSetup = [
    pinMode(pins.dc, 'OUTPUT'),
    pinMode(pins.rst, 'OUTPUT'),
    pinMode(pins.bl, 'OUTPUT'),
  ]
  for (const r of pinSetup) {
    if (!r.ok) {
      return err({type: 'InitFailed' as const, message: `Pin setup failed: ${r.error.name}`})
    }
  }

  function cmd(command: number, data?: number[]) {
    digitalWrite(pins.dc, 0).orPanic('DC pin write failed')
    spi.write(new Uint8Array([command])).orPanic('SPI command write failed')
    if (data && data.length > 0) {
      digitalWrite(pins.dc, 1).orPanic('DC pin write failed')
      spi.write(new Uint8Array(data)).orPanic('SPI data write failed')
    }
  }

  function setWindow(x: number, y: number, w: number, h: number) {
    // In landscape mode (MADCTL_MV | MADCTL_MX), x maps to RASET and y to CASET
    const xs = x + offsetY
    const xe = x + w - 1 + offsetY
    const ys = y + offsetX
    const ye = y + h - 1 + offsetX

    cmd(CMD_CASET, [xs >> 8, xs & 0xff, xe >> 8, xe & 0xff])
    cmd(CMD_RASET, [ys >> 8, ys & 0xff, ye >> 8, ye & 0xff])
    cmd(CMD_RAMWR)
  }

  // Hardware reset
  digitalWrite(pins.rst, 1).orPanic('RST pin write failed')
  await sleep(10)
  digitalWrite(pins.rst, 0).orPanic('RST pin write failed')
  await sleep(10)
  digitalWrite(pins.rst, 1).orPanic('RST pin write failed')
  await sleep(120)

  // Init sequence
  cmd(CMD_SWRESET)
  await sleep(150)
  cmd(CMD_SLPOUT)
  await sleep(120)
  cmd(CMD_COLMOD, [0x55]) // 16-bit RGB565
  cmd(CMD_MADCTL, [MADCTL_MX | MADCTL_MV | MADCTL_RGB]) // landscape
  cmd(CMD_INVON)
  cmd(CMD_NORON)
  await sleep(10)
  cmd(CMD_DISPON)
  await sleep(10)
  digitalWrite(pins.bl, 1).orPanic('Backlight enable failed')

  return ok({
    width,
    height,
    fillScreen(color: number) {
      this.fillRect(0, 0, width, height, color)
    },
    fillRect(x: number, y: number, w: number, h: number, color: number) {
      setWindow(x, y, w, h)
      const hi = (color >> 8) & 0xff
      const lo = color & 0xff
      const totalPixels = w * h
      const chunkPixels = Math.min(totalPixels, 512)
      const buf = new Uint8Array(chunkPixels * 2)
      for (let i = 0; i < chunkPixels; i++) {
        buf[i * 2] = hi
        buf[i * 2 + 1] = lo
      }
      digitalWrite(pins.dc, 1).orPanic('DC pin write failed')
      let remaining = totalPixels
      while (remaining > 0) {
        const pixels = Math.min(remaining, chunkPixels)
        if (pixels === chunkPixels) {
          spi.write(buf).orPanic('SPI write failed')
        } else {
          spi.write(buf.subarray(0, pixels * 2)).orPanic('SPI write failed')
        }
        remaining -= pixels
      }
    },
    drawBitmap(x: number, y: number, w: number, h: number, data: Uint8Array) {
      setWindow(x, y, w, h)
      digitalWrite(pins.dc, 1).orPanic('DC pin write failed')
      spi.write(data).orPanic('SPI write failed')
    },
  })
}

/** Convert RGB components (0-255) to RGB565 */
export function rgb565(r: number, g: number, b: number): number {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)
}

/** Convert HSV (h: 0-360, s: 0-1, v: 0-1) to RGB565 */
export function hsvToRgb565(h: number, s: number, v: number): number {
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
  return rgb565(Math.floor((r + m) * 255), Math.floor((g + m) * 255), Math.floor((b + m) * 255))
}

export const Color = {
  BLACK: 0x0000,
  WHITE: 0xffff,
  RED: rgb565(255, 0, 0),
  GREEN: rgb565(0, 255, 0),
  BLUE: rgb565(0, 0, 255),
  YELLOW: rgb565(255, 255, 0),
  CYAN: rgb565(0, 255, 255),
  MAGENTA: rgb565(255, 0, 255),
} as const
