import {err, ok, type Result} from 'mikrojs/result'
import * as native from 'native:sh8601'

import type {Display, DisplayConfig} from './types.js'

export type {Display, DisplayConfig} from './types.js'

export function createDisplay(
  config: DisplayConfig,
): Result<Display, {type: 'InitFailed'; message: string}> {
  const result = native.init(config)
  if (!result.ok) {
    return err({type: 'InitFailed' as const, message: result.error ?? 'unknown error'})
  }

  return ok({
    width: config.width,
    height: config.height,
    drawBitmap(x: number, y: number, w: number, h: number, data: Uint8Array) {
      const r = native.drawBitmap(x, y, w, h, data)
      if (!r.ok) throw new Error(r.error)
    },
    fillRect(x: number, y: number, w: number, h: number, color: number) {
      const r = native.fillRect(x, y, w, h, color)
      if (!r.ok) throw new Error(r.error)
    },
    setBacklight(brightness: number) {
      const r = native.setBacklight(brightness)
      if (!r.ok) throw new Error(r.error)
    },
    sleep() {
      const r = native.sleep()
      if (!r.ok) throw new Error(r.error)
    },
    wake() {
      const r = native.wake()
      if (!r.ok) throw new Error(r.error)
    },
  })
}
