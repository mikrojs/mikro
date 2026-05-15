/* eslint-disable no-console */
/**
 * Sim wifi stub for the e2e suite.
 *
 * Returns 127.0.0.1 instead of the default 192.168.1.100 so tests that exercise
 * real UDP/TCP loopback (udp.test.ts) succeed under `mikro sim test`.
 */
import type {SimWifi} from 'mikrojs/sim'

let connected = false
const LOCAL_IP = '127.0.0.1'

export class Wifi implements SimWifi {
  connect(ssid: string, _passphrase: string) {
    console.log('[sim] wifi.connect:', ssid)
    connected = true
    const info = {ip: LOCAL_IP, netmask: '255.0.0.0', gateway: LOCAL_IP}
    return {ok: true as const, value: Promise.resolve({ok: true as const, value: info})}
  }
  disconnect() {
    return {ok: true as const}
  }
  rssi() {
    return {ok: true as const, value: -50}
  }
  ip() {
    return LOCAL_IP
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
    return 'mikrojs-e2e-sim' as string | undefined
  }
  getIpConfig() {
    if (!connected) return {ok: true as const, value: undefined}
    return {
      ok: true as const,
      value: {ip: LOCAL_IP, netmask: '255.0.0.0', gateway: LOCAL_IP, dns: '8.8.8.8'},
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
