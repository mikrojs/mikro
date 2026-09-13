/* eslint-disable no-console */
// Simulator stub for spi
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {ok} from 'mikro/result'
import type {SimSpi} from 'mikro/sim'

export const Spi: SimSpi['Spi'] = (host, _options) => {
  let released = false
  let warned = false
  // Reports use of a handle after end() once, as the device does.
  function ended(call: string) {
    if (!released) return false
    if (!warned) {
      warned = true
      console.error('Spi ' + host + ': ' + call + ' after end(); the handle no longer owns the bus')
    }
    return true
  }
  return ok({
    // Nothing is wired to a simulated bus, so a transfer reads back zeros.
    transfer(data: Uint8Array) {
      return ok(new Uint8Array(ended('transfer()') ? 0 : data.length))
    },
    write(_data: Uint8Array) {
      ended('write()')
      return ok()
    },
    end() {
      released = true
    },
  })
}
