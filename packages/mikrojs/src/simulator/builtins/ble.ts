import type {BuiltinDefinition} from './types.js'

// ble uses a raw source module (not RPC) to match the native class shape exactly
// and keep its synchronous getter/setter semantics.
export const bleBuiltin: BuiltinDefinition = {
  source: `/* eslint-disable no-console */
// Simulator stub for ble
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {err, ok} from 'mikrojs/result'

let currentName = 'mikrojs-sim'
let currentTxPower = 0
let advertising = false

export class Ble {
  getName() { return currentName }
  setName(name) { currentName = name; return ok() }
  getAddress() { return ok('00:00:00:00:00:00') }
  getTxPower() { return ok(currentTxPower) }
  setTxPower(dbm) { currentTxPower = dbm; return ok() }
  advertise(_options) {
    if (advertising) {
      return err({name: 'AlreadyAdvertising', message: 'already advertising'})
    }
    advertising = true
    console.log('[sim] ble.advertise')
    return ok()
  }
  stopAdvertising() {
    advertising = false
    return ok()
  }
  stop() {
    advertising = false
    return ok()
  }
  setValue(_serviceUuid, _characteristicUuid, _value) {
    return ok()
  }
  notify(_serviceUuid, _characteristicUuid, _value) {
    return ok()
  }
  on(_event, _listener) {}
  off(_event, _listener) {}
}
`,
}
