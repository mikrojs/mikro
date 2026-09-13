/**
 * Types for simulator stub definitions.
 *
 * This module is types-only. Users write `import type {SimWifi} from 'mikro/sim'`
 * (or the matching per-builtin type) which erases at compile time, preventing
 * accidental runtime import in app code.
 */

import type {AnalogIn, DigitalIn, DigitalOut} from '@mikrojs/native/runtime/gpio/types'
import type {I2c} from '@mikrojs/native/runtime/i2c/types'
import type {I2s} from '@mikrojs/native/runtime/i2s/types'
import type {NeoPixel} from '@mikrojs/native/runtime/neopixel/types'
import type {Pwm} from '@mikrojs/native/runtime/pwm/types'
import type {DeepWakeupSources, LightWakeupSources} from '@mikrojs/native/runtime/sleep/types'
import type {Spi} from '@mikrojs/native/runtime/spi/types'
import type {Uart} from '@mikrojs/native/runtime/uart/types'

type NR<T> = {ok: true; value: T} | {ok: false; error: {name: string; message: string}}
type NRV = {ok: true} | {ok: false; error: {name: string; message: string}}

/** Method signatures for each overridable builtin, matching the native module it replaces */
export interface SimStubMethods {
  wifi: {
    connect(
      ssid: string,
      passphrase: string,
    ): NR<Promise<NR<{ip: string; netmask: string; gateway: string}>>>
    disconnect(shutdown?: boolean): NRV
    rssi(): NR<number>
    ip(): string
    status(): number
    scan(opts?: {ssid?: string; channel?: number; passive?: boolean}): NR<Promise<NR<unknown[]>>>
    on(event: string, listener: (...args: unknown[]) => void): void
    off(event: string, listener: (...args: unknown[]) => void): void
    mac(): NR<string>
    getHostname(): string | undefined
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
  gpio: {
    DigitalOut: typeof DigitalOut
    DigitalIn: typeof DigitalIn
    AnalogIn: typeof AnalogIn
  }
  neopixel: {
    NeoPixel: typeof NeoPixel
  }
  pwm: {
    Pwm: typeof Pwm
  }
  i2c: {
    I2c: typeof I2c
  }
  i2s: {
    I2s: typeof I2s
  }
  spi: {
    Spi: typeof Spi
  }
  uart: {
    Uart: typeof Uart
  }
  sleep: {
    deepSleep(sources: DeepWakeupSources): void
    lightSleep(sources: LightWakeupSources): void
    getWakeupCause(): string
    canWakeFromExt0(): boolean
    canWakeFromExt1(): boolean
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
 * import type {SimWifi} from 'mikro/sim'
 * export class Wifi implements SimWifi {
 *   connect(ssid, passphrase) { ... }
 * }
 * ```
 */
export type SimWifi = SimStubMethods['wifi']
export type SimHttp = SimStubMethods['http']
export type SimGpio = SimStubMethods['gpio']
export type SimNeoPixel = SimStubMethods['neopixel']
export type SimPwm = SimStubMethods['pwm']
export type SimI2c = SimStubMethods['i2c']
export type SimI2s = SimStubMethods['i2s']
export type SimSpi = SimStubMethods['spi']
export type SimUart = SimStubMethods['uart']
export type SimSleep = SimStubMethods['sleep']
export type SimKv = SimStubMethods['kv']
export type SimNvsKv = SimStubMethods['nvs_kv']

/** Generic accessor: `SimStubInterface<'wifi'>` is the same as `SimWifi` */
export type SimStubInterface<Name extends SimStubName> = SimStubMethods[Name]
