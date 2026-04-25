/**
 * Types for simulator stub definitions.
 *
 * This module is types-only. Users write `import type {SimStub} from 'mikrojs/sim'`
 * which erases at compile time, preventing accidental runtime import in app code.
 */

type NR<T> = {ok: true; value: T} | {ok: false; error: {name: string; message: string}}
type NRV = {ok: true} | {ok: false; error: {name: string; message: string}}

/** Method signatures for each overridable builtin, matching the native:* native interface */
export interface SimStubMethods {
  wifi: {
    connect(
      ssid: string,
      passphrase: string,
    ): NR<Promise<NR<{ip: string; netmask: string; gateway: string}>>>
    disconnect(): NRV
    rssi(): NR<number>
    ip(): string
    status(): number
    scan(opts?: {ssid?: string; channel?: number; passive?: boolean}): NR<Promise<NR<unknown[]>>>
    on(event: string, listener: (...args: unknown[]) => void): void
    off(event: string, listener: (...args: unknown[]) => void): void
    mac(): NR<string>
    getHostname(): string | undefined
    setHostname(hostname: string): NRV
    getIpConfig(): NR<{ip: string; netmask: string; gateway: string; dns: string} | undefined>
    setIpConfig(opts: {
      ip?: string
      netmask?: string
      gateway?: string
      dns?: string
      dhcp?: boolean
    }): NRV
    apStart(opts: {
      ssid: string
      passphrase?: string
      authMode?: string
      channel?: number
      hidden?: boolean
      maxConnections?: number
    }): NRV
    apStop(): NRV
    apIsActive(): boolean
    apIp(): string | undefined
    apStations(): {mac: string; rssi: number}[]
    apDeauthStation(mac: string): NRV
    apGetInactiveTimeout(): NR<number>
    apSetInactiveTimeout(seconds: number): NRV
    getTxPower(): NR<number>
    setTxPower(dbm: number): NRV
    getRssiThreshold(): number
    setRssiThreshold(threshold: number): NRV
    getPowerSave(): string
    setPowerSave(mode: string): NRV
    getCountry(): string | undefined
    setCountry(cc: string): NRV
  }
  http: {
    request(
      url: string,
      options?: {method?: string; body?: Uint8Array; headers?: [string, string][]},
    ):
      | {
          ok: true
          id: number
          headers: Promise<NR<{status: number; headers: [string, string][]}>>
        }
      | {ok: false; error: {name: string; message: string}}
    nextMessage(
      id: number,
    ): Promise<
      | {kind: 'chunk'; data: Uint8Array}
      | {kind: 'end'}
      | {kind: 'error'; cancelled: boolean; message: string}
    >
    cancel(id: number): void
    pendingCount(): number
  }
  pin: {
    pinMode(pin: number, mode: number): NRV
    digitalWrite(pin: number, value: number): NRV
    digitalRead(pin: number): number
    analogRead(pin: number, attenuation: number): NR<number>
    analogReadMillivolts(pin: number, attenuation: number): NR<number>
  }
  i2c: {
    begin(): NRV
    end(): NRV
    scan(): NR<Uint8Array>
    write(address: number, data: Uint8Array, stop?: boolean): NRV
    read(address: number, bytes: number): NR<Uint8Array>
  }
  spi: {
    begin(): NRV
    end(): NRV
    transfer(data: Uint8Array): NR<Uint8Array>
    write(data: Uint8Array): NRV
  }
  sleep: {
    deepSleep(ms: number): void
    lightSleep(ms: number): NRV
    getWakeupCause(): string
    enableTimerWakeup(us: number): NRV
    enableGpioWakeup(pin: number, level: number): NRV
    enableExt0Wakeup(pin: number, level: number): NRV
    enableExt1Wakeup(pinMask: number, mode: number): NRV
    disableWakeupSource(source?: string): NRV
  }
  kv: {
    set(key: string, value: unknown): void
    get(key: string): unknown
    remove(key: string): boolean
    clear(): void
    info(): {used: number; total: number; entries: number}
  }
  nvs_kv: {
    set(key: string, value: unknown): void
    get(key: string): unknown
    remove(key: string): boolean
    clear(): void
    info(): {entries: number; used: number; total: number; free: number}
  }
}

/** Names of builtins that can be overridden with sim stubs */
export type SimStubName = keyof SimStubMethods

/**
 * Per-builtin interface types for sim stubs. Use these with `implements`
 * on class-based stubs or to type-check function exports.
 *
 * @example
 * ```ts
 * import type {SimWifi} from 'mikrojs/sim'
 * export class Wifi implements SimWifi {
 *   connect(ssid, passphrase) { ... }
 * }
 * ```
 */
export type SimWifi = SimStubMethods['wifi']
export type SimHttp = SimStubMethods['http']
export type SimPin = SimStubMethods['pin']
export type SimI2c = SimStubMethods['i2c']
export type SimSpi = SimStubMethods['spi']
export type SimSleep = SimStubMethods['sleep']
export type SimKv = SimStubMethods['kv']
export type SimNvsKv = SimStubMethods['nvs_kv']

/** Generic accessor: `SimStubInterface<'wifi'>` is the same as `SimWifi` */
export type SimStubInterface<Name extends SimStubName> = SimStubMethods[Name]
