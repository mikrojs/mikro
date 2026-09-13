import type {BuiltinDefinition} from './types.js'

export const i2sBuiltin: BuiltinDefinition = {
  source: `/* eslint-disable no-console */
// Simulator stub for i2s
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {err, ok} from 'mikro/result'
import type {SimI2s} from 'mikro/sim'

type Options = {dout?: number; din?: number; sampleRate: number}

// The factory is overloaded on its options, so the implementation is cast to its type.
export const I2s = ((port: number, options: Options) => {
  let released = false
  let warned = false
  // Reports use of a handle after end() once, as the device does.
  function ended(call: string) {
    if (!released) return false
    if (!warned) {
      warned = true
      console.error('I2s ' + port + ': ' + call + ' after end(); the handle no longer owns the port')
    }
    return true
  }
  return ok({
    // Samples go nowhere; a write resolves as if DMA took it.
    async write(_data: Int16Array | Int32Array | Uint8Array) {
      if (ended('write()')) return ok()
      if (options.dout === undefined) return err({name: 'NoTxPin' as const})
      return ok()
    },
    // Nothing is connected, so a capture returns silence.
    capture(frames: number) {
      if (ended('capture()')) return ok(new Int16Array(0))
      if (options.din === undefined) return err({name: 'NoRxPin' as const})
      if (!(Number.isInteger(frames) && frames >= 1 && frames <= 16777216)) {
        return err({name: 'InvalidParam' as const, message: 'frames must be a whole number from 1 to 16777216, got ' + frames})
      }
      return ok(new Int16Array(frames))
    },
    end() {
      released = true
    },
  })
}) as unknown as SimI2s['I2s']
`,
}
