import type {BuiltinDefinition} from './types.js'

export const neopixelBuiltin: BuiltinDefinition = {
  source: `/* eslint-disable no-console */
// Simulator stub for neopixel
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {err, ok} from 'mikro/result'
import type {SimNeoPixel} from 'mikro/sim'

export const NeoPixel: SimNeoPixel['NeoPixel'] = (gpio, options) => {
  if (options.count < 1 || options.count > 1024) {
    return err({name: 'InvalidParam' as const, message: 'count must be 1 to 1024, got ' + options.count})
  }
  let released = false
  let warned = false
  // Reports use of a handle after end() once, as the device does.
  function ended(call: string) {
    if (!released) return false
    if (!warned) {
      warned = true
      console.error('NeoPixel ' + gpio + ': ' + call + ' after end(); the handle no longer owns the pin')
    }
    return true
  }
  return ok({
    setPixel(index: number) {
      if (ended('setPixel()')) return ok()
      if (index < 0 || index >= options.count) return err({name: 'IndexOutOfRange' as const})
      return ok()
    },
    fill() {
      ended('fill()')
      return ok()
    },
    show() {
      ended('show()')
      return ok()
    },
    clear() {
      ended('clear()')
      return ok()
    },
    end() {
      released = true
    },
  })
}
`,
}
