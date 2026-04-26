import type {BuiltinDefinition} from './types.js'

// wifi uses a raw source module instead of RPC because connect() and scan()
// return {ok, value: Promise<...>} which can't survive JSON serialization.
export const wifiBuiltin: BuiltinDefinition = {
  source: `/* eslint-disable no-console */
// Simulator stub for wifi
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {ok} from 'mikrojs/result'
import type {SimWifi} from 'mikrojs/sim'

let connected = false
let currentIp = '0.0.0.0'

export class Wifi implements SimWifi {
  connect(ssid: string, _passphrase: string) {
    console.log('[sim] wifi.connect:', ssid)
    connected = true
    currentIp = '192.168.1.100'
    const info = {ip: currentIp, netmask: '255.255.255.0', gateway: '192.168.1.1'}
    return ok(Promise.resolve(ok(info)))
  }
  disconnect() { return ok() }
  rssi() { return ok(-50) }
  ip() { return currentIp }
  status() { return connected ? 3 : 6 }
  scan() { return ok(Promise.resolve(ok([] as never[]))) }
  on() {}
  off() {}
  mac() { return ok('00:00:00:00:00:00') }
  getHostname() { return 'mikrojs-sim' as string | undefined }
  setHostname() { return ok() }
  getIpConfig() {
    if (!connected) return ok(undefined)
    return ok({ip: currentIp, netmask: '255.255.255.0', gateway: '192.168.1.1', dns: '8.8.8.8'})
  }
  setIpConfig() { return ok() }
  apStart() { return ok() }
  apStop() { return ok() }
  apIsActive() { return false }
  apIp() { return undefined }
  apStations() { return [] as {mac: string; rssi: number}[] }
  apDeauthStation() { return ok() }
  apGetInactiveTimeout() { return ok(300) }
  apSetInactiveTimeout() { return ok() }
  getTxPower() { return ok(20) }
  setTxPower() { return ok() }
  getRssiThreshold() { return -127 }
  setRssiThreshold() { return ok() }
  getPowerSave() { return 'NONE' }
  setPowerSave() { return ok() }
  getCountry() { return undefined }
  setCountry() { return ok() }
}
`,
}
