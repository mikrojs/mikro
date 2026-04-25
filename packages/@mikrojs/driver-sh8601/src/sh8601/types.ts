import type {Result} from 'mikrojs/result'

export interface DisplayConfig {
  width: number
  height: number
  spiHost: number
  pins: {
    clk: number
    d0: number
    d1: number
    d2: number
    d3: number
    cs: number
    rst: number
    bl: number
  }
}

export interface Display {
  /** Write RGB565 pixel data to a rectangular region */
  drawBitmap(x: number, y: number, w: number, h: number, data: Uint8Array): void
  /** Fill a rectangle with an RGB565 color */
  fillRect(x: number, y: number, w: number, h: number, color: number): void
  /** Set backlight brightness (0-100) */
  setBacklight(brightness: number): void
  /** Put display to sleep */
  sleep(): void
  /** Wake display from sleep */
  wake(): void
  /** Display width in pixels */
  readonly width: number
  /** Display height in pixels */
  readonly height: number
}

export declare function createDisplay(
  config: DisplayConfig,
): Result<Display, {type: 'InitFailed'; message: string}>
