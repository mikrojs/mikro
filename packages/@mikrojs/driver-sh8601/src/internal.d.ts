interface NativeResult<T = void> {
  ok: boolean
  value?: T
  error?: string
}

declare module 'native:sh8601' {
  export function init(config: {
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
  }): NativeResult

  export function drawBitmap(
    x: number,
    y: number,
    w: number,
    h: number,
    data: Uint8Array,
  ): NativeResult

  export function fillRect(x: number, y: number, w: number, h: number, color: number): NativeResult

  export function setBacklight(brightness: number): NativeResult
  export function sleep(): NativeResult
  export function wake(): NativeResult
}
