import {lazyEvent} from 'mikro/observable/lazy'
import {err, ok} from 'mikro/result'
import {Wifi as NativeWifi} from 'native:mikro/wifi'

import type {Result} from '../result/types.js'
import type {
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
  WifiDisconnectReason,
  WifiError,
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

  onStationConnect: lazyEvent<ApStationInfo>(native, 'station-connect'),
  onStationDisconnect: lazyEvent<ApStationInfo>(native, 'station-disconnect'),
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

  onConnect: lazyEvent<WifiConnectionInfo>(native, 'connect'),
  onDisconnect: lazyEvent<WifiDisconnectReason>(native, 'disconnect'),
  onRssiLow: lazyEvent<number>(native, 'rssi-low'),

  get mac(): string {
    const result = native.mac()
    return result.ok ? result.value : ''
  },

  get hostname(): string | undefined {
    return native.getHostname()
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
}

export {wifi}
