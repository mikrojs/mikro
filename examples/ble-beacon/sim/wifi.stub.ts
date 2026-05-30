/* eslint-disable no-console */
// Simulator stub for wifi
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import type {SimWifi} from 'mikro/sim'

let connected = false
let currentIp = '0.0.0.0'

export class Wifi implements SimWifi {
  connect(ssid: string, _passphrase: string) {
    console.log('[sim] wifi.connect:', ssid)
    connected = true
    currentIp = '192.168.1.100'
    const info = {ip: currentIp, netmask: '255.255.255.0', gateway: '192.168.1.1'}
    return {ok: true as const, value: Promise.resolve({ok: true as const, value: info})}
  }
  disconnect() {
    return {ok: true as const}
  }
  rssi() {
    return {ok: true as const, value: -50}
  }
  ip() {
    return currentIp
  }
  status() {
    return connected ? 3 : 6
  }
  scan() {
    return {ok: true as const, value: Promise.resolve({ok: true as const, value: [] as never[]})}
  }
  on() {}
  off() {}
  mac() {
    return {ok: true as const, value: '00:00:00:00:00:00'}
  }
  getHostname() {
    return 'mikrojs-sim' as string | undefined
  }
  getIpConfig() {
    if (!connected) return {ok: true as const, value: undefined}
    return {
      ok: true as const,
      value: {ip: currentIp, netmask: '255.255.255.0', gateway: '192.168.1.1', dns: '8.8.8.8'},
    }
  }
  setIpConfig() {
    return {ok: true as const}
  }
  apStart() {
    return {ok: true as const}
  }
  apStop() {
    return {ok: true as const}
  }
  apIsActive() {
    return false
  }
  apIp() {
    return undefined
  }
  apStations() {
    return [] as {mac: string; rssi: number}[]
  }
  apDeauthStation() {
    return {ok: true as const}
  }
  apGetInactiveTimeout() {
    return {ok: true as const, value: 300}
  }
  apSetInactiveTimeout() {
    return {ok: true as const}
  }
  getTxPower() {
    return {ok: true as const, value: 20}
  }
  setTxPower() {
    return {ok: true as const}
  }
  getRssiThreshold() {
    return -127
  }
  setRssiThreshold() {
    return {ok: true as const}
  }
  getPowerSave() {
    return 'NONE'
  }
  setPowerSave() {
    return {ok: true as const}
  }
  getCountry() {
    return undefined
  }
}
