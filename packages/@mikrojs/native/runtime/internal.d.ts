// Native C modules provided by the firmware, not importable by user scripts

type NR<T> = {ok: true; value: T} | {ok: false; error: {code: number; message: string}}

// Internal shared runtime modules. Registered as builtins so sibling bundles
// can reference them at runtime to dedupe shared code, but not exposed via
// the public `mikro/*` subpath exports so user apps can't accidentally
// import them. Keep these in sync with the MODULES list in the firmware +
// @mikrojs/native CMakeLists.
declare module 'mikro/kv/shared' {
  export {KVError, makeCreateValue, type NativeKvFns} from './kv/shared.js'
}

declare module 'mikro/observable/lazy' {
  export {lazyEvent} from './observable/lazy.js'
}

declare module 'native:cbor' {
  import type {CborError} from '@mikrojs/native/runtime/cbor/types'
  import type {Result} from 'mikro/result'
  export function encode(value: unknown): Result<Uint8Array, CborError>
  export function decode(data: Uint8Array): Result<unknown, CborError>
}

declare module 'native:result' {
  import type {ErrResult, OkResult} from './result/types.js'
  export function ok(): OkResult<void>
  export function ok<T>(value: T): OkResult<T>
  export function err<E>(error: E): ErrResult<E>
}

declare module 'native:observable' {
  export {Observable} from '@mikrojs/native/runtime/observable/types'
}

declare module 'native:sys' {
  import type {JsMemoryUsage, ResetReason} from './sys/types.js'
  export function evalScript(code: string): Promise<{value: unknown}>
  export function memoryUsage(): {
    heapUsed: number
    heapTotal: number
    systemFree: number
    systemMinFree: number
    systemTotal: number
    systemLargestFree: number
  }
  export function jsMemoryUsage(): JsMemoryUsage
  export function gc(): void
  /** Unload the module whose namespace object is `ns`; returns the number of
   *  modules freed (0 if `ns` is not a loaded module's namespace). */
  export function unloadNamespace(ns: object): number
  /** True if `ns` is the namespace of a loaded, non-anchored (non-builtin) module. */
  export function isUnloadableNamespace(ns: object): boolean
  export function activeTimers(): number
  export function setTime(millisSinceEpoch: number): void
  export function uptime(): {boot: number; rtc: number}
  export function restart(): never
  export const version: string
  export const board: {
    name: string
    chip: string
    cores: number
    revision: number
    features: string[]
    flash: number
    psram: number
  }
  export const firmware: {hash: string; date: string; idfVersion: string | undefined}
  export const deviceId: string
  export const resetReason: ResetReason
}

declare module 'native:fs' {
  import type {DirEntry, FSError, MkdirOptions, StatResult, WriteFileOptions} from './fs/types.js'
  import type {Result} from './result/types.js'

  export interface FileHandle {
    /** Reads up to `size` bytes. Value is `undefined` at EOF. */
    read(size: number): Result<Uint8Array | undefined, FSError>
    write(data: Uint8Array | string): Result<number, FSError>
    seek(offset: number, whence?: 'start' | 'current' | 'end'): Result<number, FSError>
    close(): Result<void, FSError>
    stat(): Result<StatResult, FSError>
    readonly path: string
  }

  export type OpenMode = 'r' | 'w' | 'a' | 'r+' | 'w+' | 'a+'

  export function open(path: string, mode?: OpenMode): Result<FileHandle, FSError>
  export function readFile(path: string): Result<Uint8Array, FSError>
  export function readFile(path: string, encoding: 'utf-8'): Result<string, FSError>
  export function writeFile(
    path: string,
    contents: string,
    options?: WriteFileOptions,
  ): Result<void, FSError>
  export function writeFile(
    path: string,
    contents: Uint8Array,
    options?: WriteFileOptions,
  ): Result<void, FSError>
  export function stat(path: string): Result<StatResult, FSError>
  export function readDir(path: string): Result<DirEntry[], FSError>
  export function unlink(path: string): Result<void, FSError>
  export function rename(from: string, to: string): Result<void, FSError>
  export function mkdir(path: string, options?: MkdirOptions): Result<void, FSError>
  export function rmdir(path: string): Result<void, FSError>
  export function exists(path: string): boolean
}

declare module 'native:stdio' {
  export const stdout: {
    write(output: Uint8Array | string): boolean
    flush(): void
  }

  export const stdin: {
    read(): undefined | Uint8Array
    setHandler(handler: (data: Uint8Array) => void): void
    clearHandler(): void
  }
}

declare module 'native:pin' {
  import type {PinError} from '@mikrojs/native/runtime/pin/types'
  import type {Result} from 'mikro/result'
  export type PinMode = 0x01 | 0x03 | 0x05
  export function pinMode(pin: number, value: PinMode): Result<void, PinError>
  export function digitalWrite(pin: number, value: 0 | 1): Result<void, PinError>
  export function digitalRead(pin: number): number
  // attenuation: 0=0dB, 1=2.5dB, 2=6dB, 3=11dB
  export function analogRead(pin: number, attenuation: number): Result<number, PinError>
  export function analogReadMillivolts(pin: number, attenuation: number): Result<number, PinError>
}

declare module 'native:sleep' {
  import type {DeepWakeupSources, LightWakeupSources} from '@mikrojs/native/runtime/sleep/types'

  export function deepSleep(sources: DeepWakeupSources): never
  export function lightSleep(sources: LightWakeupSources): void
  export function getWakeupCause(): string
  export function canWakeFromExt0(): boolean
  export function canWakeFromExt1(): boolean
}

declare module 'native:http' {
  import type {RequestError} from 'mikro/http/helpers'
  import type {Result} from 'mikro/result'

  import type {ErrResult} from './result/types.js'
  type HeadersMsg = {status: number; headers: [string, string][]}
  export type HttpMessage =
    | {kind: 'chunk'; data: Uint8Array}
    | {kind: 'end'}
    | {kind: 'error'; cancelled: boolean; message: string}
  export type HttpRequestStart =
    | {ok: true; id: number; headers: Promise<Result<HeadersMsg, RequestError>>}
    | ErrResult<RequestError>
  export function request(
    url: string,
    options?: {method?: string; body?: Uint8Array; headers?: [string, string][]},
  ): HttpRequestStart
  export function nextMessage(id: number): Promise<HttpMessage>
  export function cancel(id: number): void
  export function pendingCount(): number
}

declare module 'native:http_server' {
  import type {Result} from 'mikro/result'

  import type {ServerError} from './http/server-impl.js'

  export type NativeRequestDescriptor = {
    id: number
    method: string
    url: string
    body: Uint8Array
    bodyTooLarge: boolean
    contentLength: number
  }
  export function start(port: number, maxBodySize?: number): Result<void, ServerError>
  export function stop(): void
  export function nextRequest(): Promise<NativeRequestDescriptor | {closed: true}>
  export function respond(
    id: number,
    status: number,
    headers: [string, string][],
    body?: Uint8Array,
  ): void
  export function respondStart(
    id: number,
    status: number,
    headers: [string, string][],
  ): Promise<void>
  export function respondChunk(id: number, data: Uint8Array): Promise<boolean>
  export function respondEnd(id: number): void
  export function getHeader(id: number, name: string): string | undefined
}
declare module 'native:i2c' {
  import type {I2cError} from '@mikrojs/native/runtime/i2c/types'
  import type {Result} from 'mikro/result'

  export interface I2cBaseOptions {
    freq?: number
    timeout?: number
  }

  export interface I2cOptionsWithPins extends I2cBaseOptions {
    sda: number
    scl: number
  }

  export type I2cOptions = I2cBaseOptions | I2cOptionsWithPins
  export declare const I2c: {
    prototype: I2c
    new (busNo: 0 | 1, options?: I2cOptions): I2c
  }

  export interface I2c {
    begin(): Result<void, I2cError>

    end(): Result<void, I2cError>

    read(address: number, bytes: number): Result<Uint8Array, I2cError>

    write(address: number, data: Uint8Array, stop?: boolean): Result<void, I2cError>

    scan(): Result<Uint8Array, I2cError>
  }
}
declare module 'native:spi' {
  import type {SpiError} from '@mikrojs/native/runtime/spi/types'
  import type {Result} from 'mikro/result'

  export interface SpiOptions {
    clk: number
    mosi: number
    miso?: number
    cs?: number
    freq?: number
    mode?: 0 | 1 | 2 | 3
  }

  export declare const Spi: {
    prototype: Spi
    new (hostNo: 1 | 2, options: SpiOptions): Spi
  }

  export interface Spi {
    begin(): Result<void, SpiError>

    end(): Result<void, SpiError>

    transfer(data: Uint8Array): Result<Uint8Array, SpiError>

    write(data: Uint8Array): Result<void, SpiError>
  }
}

declare module 'native:sntp' {
  import type {SntpError} from '@mikrojs/native/runtime/sntp/types'
  import type {Result} from 'mikro/result'
  /**
   * Native errors: the outer Result covers init/config failures (InitFailed);
   * the inner Result on resolve covers post-start errors (Cancelled).
   * `Timeout` is owned by the JS-side Promise racer in mikrojs/sntp, not
   * emitted by native.
   */
  export function sync(
    servers: string[],
    timezone: string,
    background: boolean,
  ): Result<Promise<Result<{time: number}, SntpError>>, SntpError>
  export function stop(): void
  export function setTimezone(tz: string): void
}

declare module 'native:rtc' {
  type NRV = {ok: true} | {ok: false; error: {code: number; message: string}}
  export function set(key: string, value: unknown): NRV
  export function get(key: string): unknown
  export function remove(key: string): boolean
  export function clear(): void
  export function info(): {used: number; total: number; entries: number}
}

declare module 'native:nvs_kv' {
  type NRV = {ok: true} | {ok: false; error: {code: number; message: string}}
  export function set(key: string, value: unknown): NRV
  export function get(key: string): unknown
  export function remove(key: string): boolean
  export function clear(): void
  export function info(): {entries: number; used: number; total: number; free: number}
}

declare module 'native:pwm' {
  import type {PwmError} from '@mikrojs/native/runtime/pwm/types'
  import type {Result} from 'mikro/result'

  export declare const Pwm: {
    prototype: Pwm
    new (pin: number, freq: number, duty: number): Pwm
  }

  export interface Pwm {
    duty(value?: number): Result<number, PwmError>
    freq(value?: number): Result<number, PwmError>
    fade(target: number, durationMs: number): Result<Promise<void>, PwmError>
    end(): Result<void, PwmError>
  }
}

declare module 'native:neopixel' {
  import type {NeoPixelError} from '@mikrojs/native/runtime/neopixel/types'
  import type {Result} from 'mikro/result'

  export declare const NeoPixel: {
    prototype: NeoPixel
    new (pin: number, numLeds: number, bytesPerLed: number): NeoPixel
  }

  export interface NeoPixel {
    setPixel(index: number, r: number, g: number, b: number, w: number): Result<void, NeoPixelError>
    fill(r: number, g: number, b: number, w: number): Result<void, NeoPixelError>
    show(): Result<void, NeoPixelError>
    clear(): Result<void, NeoPixelError>
    end(): Result<void, NeoPixelError>
  }
}

declare module 'native:uart' {
  import type {UartError} from '@mikrojs/native/runtime/uart/types'
  import type {Result} from 'mikro/result'

  export interface UartOptions {
    tx?: number
    rx?: number
    baudRate: number
  }

  export declare const Uart: {
    prototype: Uart
    new (port: number, options: UartOptions): Uart
  }

  export interface Uart {
    begin(): Result<void, UartError>

    end(): Result<void, UartError>

    write(data: Uint8Array): Result<void, UartError>

    read(): Result<
      {
        next(): Promise<IteratorResult<Result<Uint8Array, UartError>>>
        return(): Promise<IteratorResult<Result<Uint8Array, UartError>>>
      },
      UartError
    >
  }
}

declare module 'native:ble' {
  import type {BleError} from '@mikrojs/native/runtime/ble/types'
  import type {Result} from 'mikro/result'

  type R<T> = Result<T, BleError>

  export interface CharacteristicNative {
    uuid: string
    properties: number // bitmask
    value?: Uint8Array
    onWrite?: (value: Uint8Array) => void
    writeMode?: string
    security?: string
  }

  export interface ServiceNative {
    uuid: string
    characteristics: CharacteristicNative[]
  }

  export interface AdvertiseOptionsNative {
    name?: string
    connectable?: boolean
    services?: ServiceNative[]
    interval?: {min: number; max: number}
    includeTxPower?: boolean
    manufacturerData?: Uint8Array
  }

  export interface Ble {
    getName(): string
    setName(name: string): R<void>
    getAddress(): R<string>

    getTxPower(): R<number>
    setTxPower(dbm: number): R<void>

    advertise(options: AdvertiseOptionsNative): R<void>
    stopAdvertising(): R<void>
    stop(): R<void>

    setValue(serviceUuid: string, characteristicUuid: string, value: Uint8Array): R<void>
    notify(serviceUuid: string, characteristicUuid: string, value: Uint8Array): R<void>

    on(event: string, listener: (...args: unknown[]) => void): void
    off(event: string, listener: (...args: unknown[]) => void): void
  }

  export declare const Ble: {
    prototype: Ble
    new (): Ble
  }
}

declare module 'native:wifi' {
  import type {WifiError} from '@mikrojs/native/runtime/wifi/types'
  import type {Result} from 'mikro/result'

  type R<T> = Result<T, WifiError>

  export interface Wifi {
    connect(
      ssid: string,
      passphrase: string,
    ): R<Promise<R<{ip: string; netmask: string; gateway: string}>>>
    disconnect(): R<void>
    rssi(): R<number>
    ip(): string
    status(): number
    scan(opts?: {ssid?: string; channel?: number; passive?: boolean}): R<
      Promise<
        R<
          {
            ssid: string
            bssid: string
            channel: number
            rssi: number
            authMode: string
            hidden: boolean
          }[]
        >
      >
    >
    on(event: string, listener: (...args: unknown[]) => void): void
    off(event: string, listener: (...args: unknown[]) => void): void

    // Network config
    mac(): R<string>
    getHostname(): string | undefined
    getIpConfig(): R<{ip: string; netmask: string; gateway: string; dns: string} | undefined>
    setIpConfig(opts: {
      ip?: string
      netmask?: string
      gateway?: string
      dns?: string
      dhcp?: boolean
    }): R<void>

    // AP mode
    apStart(opts: {
      ssid: string
      passphrase?: string
      authMode?: string
      channel?: number
      hidden?: boolean
      maxConnections?: number
    }): R<void>
    apStop(): R<void>
    apIsActive(): boolean
    apIp(): string | undefined
    apStations(): {mac: string; rssi: number}[]

    // TX power & RSSI threshold
    getTxPower(): R<number>
    setTxPower(dbm: number): R<void>
    getRssiThreshold(): number
    setRssiThreshold(threshold: number): R<void>

    // AP extras
    apDeauthStation(mac: string): R<void>
    apGetInactiveTimeout(): R<number>
    apSetInactiveTimeout(seconds: number): R<void>

    // Power management & misc
    getPowerSave(): string
    setPowerSave(mode: string): R<void>
    getCountry(): string | undefined
  }

  export declare const Wifi: {
    prototype: Wifi
    new (): Wifi
  }
}

declare module 'native:udp' {
  import type {
    BindOptions,
    PeerAddress,
    UdpError,
    UdpFamily,
  } from '@mikrojs/native/runtime/udp/types'
  import type {Result} from 'mikro/result'

  export interface NativeUdpSocket {
    readonly port: number
    readonly family: UdpFamily | 'dual'
    dropped: number

    setOnMessage(fn: ((msg: Uint8Array, from: PeerAddress) => void) | null): void
    send(data: Uint8Array, to: PeerAddress): Promise<Result<void, UdpError>>
    joinMulticastGroup(address: string): Result<void, UdpError>
    leaveMulticastGroup(address: string): Result<void, UdpError>
    close(): void
  }

  export function bind(opts: BindOptions): Promise<Result<NativeUdpSocket, UdpError>>
}
