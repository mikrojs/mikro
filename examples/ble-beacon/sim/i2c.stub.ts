/* eslint-disable no-console */
// Simulator stub for i2c
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {ok} from 'mikro/result'
import type {SimI2c} from 'mikro/sim'

export const I2c: SimI2c['I2c'] = (bus, _options) => {
  let released = false
  let warned = false
  // Reports use of a handle after end() once, as the device does.
  function ended(call: string) {
    if (!released) return false
    if (!warned) {
      warned = true
      console.error('I2c ' + bus + ': ' + call + ' after end(); the handle no longer owns the bus')
    }
    return true
  }
  // No devices answer on a simulated bus: scans find nothing and reads return zeros.
  return ok({
    read(_address: number, bytes: number) {
      return ok(new Uint8Array(ended('read()') ? 0 : bytes))
    },
    write(_address: number, _data: Uint8Array, _stop?: boolean) {
      ended('write()')
      return ok()
    },
    scan() {
      ended('scan()')
      return ok(new Uint8Array())
    },
    end() {
      released = true
    },
  })
}
