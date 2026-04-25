import {err, ok} from 'mikrojs/result'
import {Wifi as NativeWifi} from 'native:wifi'

import type {Result} from '../result/types.js'
import type {
  ApEventMap,
  ApStartOptions,
  ApStationInfo,
  IpConfig,
  PowerSaveMode,
  ScanOptions,
  ScanResult,
  StaticIpConfig,
  Wifi,
  WifiAp,
  WifiConnectionInfo,
  WifiCountryCode,
  WifiError,
  WifiEventMap,
  WifiStatus,
} from './types.js'

const WifiStatusCodes: Record<WifiStatus, number> = {
  STOPPED: 254,
  IDLE: 0,
  NO_SSID_AVAIL: 1,
  SCAN_COMPLETED: 2,
  CONNECTED: 3,
  CONNECT_FAILED: 4,
  CONNECTION_LOST: 5,
  DISCONNECTED: 6,
}

const StatusFromCode = new Map<number, WifiStatus>(
  Object.entries(WifiStatusCodes).map(([k, v]) => [v, k as WifiStatus]),
)

const native = new NativeWifi()

const ap: WifiAp = {
  start(options: ApStartOptions): Result<void, WifiError> {
    return native.apStart(options as Parameters<typeof native.apStart>[0])
  },

  stop(): Result<void, WifiError> {
    return native.apStop()
  },

  get isActive(): boolean {
    return native.apIsActive()
  },

  get ip(): string | undefined {
    return native.apIp()
  },

  get stations(): ApStationInfo[] {
    return native.apStations()
  },

  deauthStation(mac: string): Result<void, WifiError> {
    return native.apDeauthStation(mac)
  },

  get inactiveTimeout(): number {
    const result = native.apGetInactiveTimeout()
    return result.ok ? result.value : 0
  },

  set inactiveTimeout(seconds: number) {
    native.apSetInactiveTimeout(seconds)
  },

  on<K extends keyof ApEventMap>(event: K, listener: ApEventMap[K]) {
    native.on(event, listener as (...args: unknown[]) => void)
  },

  off<K extends keyof ApEventMap>(event: K, listener: ApEventMap[K]) {
    native.off(event, listener as (...args: unknown[]) => void)
  },
}

const MAX_CONNECT_RETRIES = 5
const RETRY_DELAY_MS = 2000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const wifi: Wifi = {
  async connect(ssid: string, passphrase: string): Promise<Result<WifiConnectionInfo, WifiError>> {
    for (let attempt = 0; attempt <= MAX_CONNECT_RETRIES; attempt++) {
      const startResult = native.connect(ssid, passphrase)
      if (!startResult.ok) return startResult

      const asyncResult = await startResult.value
      if (asyncResult.ok) return ok(asyncResult.value as WifiConnectionInfo)

      if (attempt === MAX_CONNECT_RETRIES) return asyncResult

      // eslint-disable-next-line no-console
      console.warn(`WiFi connect failed, retrying in ${RETRY_DELAY_MS}ms…`)
      native.disconnect()
      await sleep(RETRY_DELAY_MS)
    }
    return err({name: 'ConnectFailed' as const, message: 'max retries exceeded'})
  },

  disconnect(): Result<void, WifiError> {
    return native.disconnect()
  },

  rssi(): Result<number, WifiError> {
    return native.rssi()
  },

  ip(): string | undefined {
    const ip = native.ip()
    return ip === '0.0.0.0' ? undefined : ip
  },

  status(): WifiStatus {
    const code = native.status()
    return StatusFromCode.get(code) ?? 'DISCONNECTED'
  },

  get isConnected(): boolean {
    return native.status() === WifiStatusCodes.CONNECTED
  },

  async scan(opts?: ScanOptions): Promise<Result<ScanResult[], WifiError>> {
    const startResult = native.scan(opts)
    if (!startResult.ok) return startResult

    const asyncResult = await startResult.value
    if (!asyncResult.ok) return asyncResult
    return ok(asyncResult.value as ScanResult[])
  },

  on<K extends keyof WifiEventMap>(event: K, listener: WifiEventMap[K]) {
    native.on(event, listener as (...args: unknown[]) => void)
  },

  off<K extends keyof WifiEventMap>(event: K, listener: WifiEventMap[K]) {
    native.off(event, listener as (...args: unknown[]) => void)
  },

  get mac(): string {
    const result = native.mac()
    return result.ok ? result.value : ''
  },

  get hostname(): string | undefined {
    return native.getHostname()
  },

  set hostname(value: string | undefined) {
    if (value !== undefined) {
      native.setHostname(value)
    }
  },

  ipConfig: ((
    opts?: StaticIpConfig,
  ): Result<IpConfig | undefined, WifiError> | Result<void, WifiError> => {
    if (opts === undefined) {
      return native.getIpConfig()
    }
    return native.setIpConfig(opts)
  }) as Wifi['ipConfig'],

  ap,

  get txPower(): number {
    const result = native.getTxPower()
    return result.ok ? result.value : 0
  },

  set txPower(dbm: number) {
    native.setTxPower(dbm)
  },

  get rssiThreshold(): number {
    return native.getRssiThreshold()
  },

  set rssiThreshold(value: number) {
    native.setRssiThreshold(value)
  },

  get powerSave(): PowerSaveMode {
    return native.getPowerSave() as PowerSaveMode
  },

  set powerSave(mode: PowerSaveMode) {
    native.setPowerSave(mode)
  },

  get country(): WifiCountryCode | undefined {
    return native.getCountry() as WifiCountryCode | undefined
  },

  set country(cc: WifiCountryCode | undefined) {
    if (cc !== undefined) {
      native.setCountry(cc)
    }
  },
}

export {wifi}
