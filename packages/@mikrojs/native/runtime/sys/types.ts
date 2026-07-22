import type {Result} from '../result/types.js'

export interface MemoryUsage {
  heapUsed: number
  heapTotal: number
  /** Free system heap in bytes (0 on host) */
  systemFree: number
  /** All-time minimum free system heap in bytes (0 on host) */
  systemMinFree: number
  /** Total system heap in bytes (0 on host) */
  systemTotal: number
  /** Largest contiguous free block in bytes (0 on host). Allocations
   *  larger than this fail even when `systemFree` is bigger; the gap
   *  between `systemLargestFree` and `systemFree` measures heap
   *  fragmentation. */
  systemLargestFree: number
  /** Free internal-SRAM bytes (0 on host). On chips with PSRAM this is
   *  the subset of free heap that lives in fast on-chip RAM, which
   *  also holds mbedTLS handshake buffers, WiFi/BLE driver state, and
   *  DMA-capable buffers. On PSRAM-equipped chips `systemFree` is
   *  dominated by PSRAM and can hide internal-SRAM pressure: watch
   *  `internalFree` instead when diagnosing TLS handshake or driver
   *  allocation failures. On chips without PSRAM, equals `systemFree`. */
  internalFree: number
  /** Largest contiguous free block in internal SRAM (0 on host).
   *  Allocations that must land in internal RAM (such as mbedTLS record
   *  buffers, ~16 KB each) fail when this drops below their size, even
   *  when `systemLargestFree` reports plenty of contiguous PSRAM. */
  internalLargestFree: number
}

export interface Uptime {
  /** Milliseconds since last boot (resets on deep sleep) */
  readonly boot: number
  /** Milliseconds from RTC clock (survives deep sleep) */
  readonly rtc: number
}

export declare function uptime(): Uptime

export declare function setSystemTime(timestamp: number): void
export declare function setSystemTime(date: Date): void

export declare function memoryUsage(): MemoryUsage

/** Curated breakdown of the QuickJS engine heap — "where is memory
 *  going?" Use this when `memoryUsage()` tells you the heap is full
 *  and you want to know *what kind* of allocation dominates. Values
 *  are in bytes unless the field name ends in `Count`. */
export interface JsMemoryUsage {
  /** Number of live JS strings */
  strCount: number
  /** Bytes held by live JS strings */
  strSize: number
  /** Number of live JS objects */
  objCount: number
  /** Bytes held by live JS object headers */
  objSize: number
  /** Number of object properties across all live objects */
  propCount: number
  /** Bytes held by property slots */
  propSize: number
  /** Number of distinct object shapes (hidden classes) */
  shapeCount: number
  /** Bytes held by shape descriptors */
  shapeSize: number
  /** Number of compiled JS functions in memory */
  jsFuncCount: number
  /** Bytes of compiled JS bytecode in memory (usually the biggest
   *  contributor to QuickJS heap on an mikrojs app) */
  jsFuncCodeSize: number
  /** Number of live arrays (fast + slow) */
  arrayCount: number
  /** Total element slots across all fast arrays */
  fastArrayElements: number
  /** Cumulative bytes deserialized via JS_ReadObject over this
   *  runtime's lifetime (bytecode of imported modules, builtins, and
   *  bjson). A monotonic counter, NOT live memory — it never goes
   *  down, so don't read it as retained ArrayBuffer storage. */
  binaryObjectSize: number
}

export declare function jsMemoryUsage(): JsMemoryUsage

export declare function gc(): void

/** Firmware version string (e.g. "0.1.0") */
export declare const version: string

export interface BoardInfo {
  /** Board name from the firmware build (e.g. "xiao-esp32c6") or "generic" */
  name: string
  /** Chip target (e.g. "esp32c6") or "host" */
  chip: string
  /** Number of CPU cores */
  cores: number
  /** Silicon revision (major * 100 + minor on ESP32, 0 on host) */
  revision: number
  /** Supported features (e.g. ["wifi", "ble"]) */
  features: string[]
  /** Flash size in bytes (0 on host) */
  flash: number
  /** PSRAM size in bytes (0 if unavailable) */
  psram: number
}

/** Board and hardware info */
export declare const board: BoardInfo

/** Unique device identifier encoded as Crockford's Base32 (10 lowercase
 * characters, no special symbols). On ESP32, derived from the chip's
 * base MAC address; the encoding is lossless so decoding the 10 chars
 * yields the original 6 MAC bytes. On host/Node builds, derived from
 * the hostname via FNV-1a hash (stable across restarts on the same
 * machine). */
/** Bytes on the app filesystem, the partition an OTA build is downloaded and
 *  staged onto. Undefined when the platform cannot report it. */
export declare function storageUsage(): {total: number; used: number; free: number} | undefined

export declare const deviceId: string

/** A device name paired with the revision that orders renames. Both sides bump
 *  the revision on every deliberate rename, so whichever is higher wins without
 *  needing a clock the device may not have. */
export interface DeviceName {
  rev: number
  /** Absent when the name is cleared, or never set. */
  name?: string
}

/** The device's name and its revision; revision 0 with no name means never
 *  named, and callers fall back to {@link deviceId}. */
export declare function deviceName(): DeviceName

/** Persist a name pair, e.g. one adopted from a registry check-in. */
export declare function setDeviceName(value: DeviceName): void

/** Firmware build identifiers */
export declare const firmware: {
  /** ELF SHA256 hash on ESP32, "dev" on host */
  readonly hash: string
  /** Build date and time */
  readonly date: string
  /** ESP-IDF version, undefined on host */
  readonly idfVersion: string | undefined
  /** QuickJS bytecode version the linked engine reads/writes */
  readonly bytecodeVersion: number
}

/** Why the device last reset. A clean `restart()` reports `'software'`;
 *  a crash reports `'panic'`. Host/Node builds always report `'unknown'`. */
export type ResetReason =
  | 'power-on'
  | 'software'
  | 'panic'
  | 'watchdog'
  | 'interrupt-watchdog'
  | 'task-watchdog'
  | 'brownout'
  | 'deep-sleep'
  | 'external'
  | 'sdio'
  | 'usb'
  | 'jtag'
  | 'efuse'
  | 'power-glitch'
  | 'cpu-lockup'
  | 'unknown'

/** Reason the device last reset, determined once at boot. */
export declare const resetReason: ResetReason

export declare function restart(): never

/** Reason the device woke up this boot. Set after deep sleep (or first
 *  boot). One of: `'timer'`, `'ext0'`, `'ext1'`, `'gpio'`, or `'undefined'`
 *  (cold boot or unknown). */
export declare function getWakeupCause(): string

export declare function exit(exitCode?: number): never

/** Immediately crash with an error message. Use for unrecoverable situations. */
export declare function panic(message: string): never

export declare class MonotonicTimestamp {
  readonly uptimeMs: number
  private constructor(uptimeMs: number)
  static now(): MonotonicTimestamp
  /** Rehydrate a previously-serialized timestamp. The `uptimeMs` value
   *  must come from the current RTC reset cycle; values from prior reset
   *  cycles will resolve to meaningless wall-clock times. */
  static fromRtcMs(uptimeMs: number): MonotonicTimestamp
  /** Elapsed ms since another MonotonicTimestamp (NTP-independent) */
  since(other: MonotonicTimestamp): number
  /** Resolve to a Date. Returns err if the system clock is clearly not synced. */
  wallDate(): Result<Date, 'ClockNotSynced'>
}
