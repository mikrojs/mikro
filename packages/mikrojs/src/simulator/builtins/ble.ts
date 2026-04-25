import type {BuiltinDefinition} from './types.js'

// ble uses a raw source module (not RPC) to match the native class shape exactly
// and keep its synchronous getter/setter semantics.
export const bleBuiltin: BuiltinDefinition = {
  source: `/* eslint-disable no-console */
// Simulator stub for ble
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.

let currentName = 'mikrojs-sim'
let currentTxPower = 0
let advertising = false

export class Ble {
  getName() { return currentName }
  setName(name) { currentName = name; return {ok: true} }
  getAddress() { return {ok: true, value: '00:00:00:00:00:00'} }
  getTxPower() { return {ok: true, value: currentTxPower} }
  setTxPower(dbm) { currentTxPower = dbm; return {ok: true} }
  advertise(_options) {
    if (advertising) {
      return {ok: false, error: {name: 'AlreadyAdvertising', message: 'already advertising'}}
    }
    advertising = true
    console.log('[sim] ble.advertise')
    return {ok: true}
  }
  stopAdvertising() {
    advertising = false
    return {ok: true}
  }
  stop() {
    advertising = false
    return {ok: true}
  }
  setValue(_serviceUuid, _characteristicUuid, _value) {
    return {ok: true}
  }
  notify(_serviceUuid, _characteristicUuid, _value) {
    return {ok: true}
  }
  on(_event, _listener) {}
  off(_event, _listener) {}
}
`,
}
