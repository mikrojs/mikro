import type {Result} from 'mikrojs/result'

export interface DisplayConfig {
  /** SPI host number (1 or 2) */
  spiHost: 1 | 2
  /** SPI clock frequency in Hz (default: 40MHz) */
  freq?: number
  /** Display width in pixels */
  width: number
  /** Display height in pixels */
  height: number
  /** X offset for the display window */
  offsetX?: number
  /** Y offset for the display window */
  offsetY?: number
  pins: {
    mosi: number
    sclk: number
    cs: number
    dc: number
    rst: number
    bl: number
  }
}

export interface Display {
  /** Fill the entire screen with a color */
  fillScreen(color: number): void
  /** Fill a rectangle with a color */
  fillRect(x: number, y: number, w: number, h: number, color: number): void
  /** Draw a bitmap (RGB565 Uint8Array) */
  drawBitmap(x: number, y: number, w: number, h: number, data: Uint8Array): void
  /** Display width in pixels */
  readonly width: number
  /** Display height in pixels */
  readonly height: number
}

export declare function createDisplay(
  config: DisplayConfig,
): Promise<Result<Display, {type: 'InitFailed'; message: string}>>

/** Convert RGB components (0-255) to RGB565 */
export declare function rgb565(r: number, g: number, b: number): number

/** Convert HSV (h: 0-360, s: 0-1, v: 0-1) to RGB565 */
export declare function hsvToRgb565(h: number, s: number, v: number): number

export declare const Color: {
  readonly BLACK: number
  readonly WHITE: number
  readonly RED: number
  readonly GREEN: number
  readonly BLUE: number
  readonly YELLOW: number
  readonly CYAN: number
  readonly MAGENTA: number
}
