import {err, ok, PanicError, type Result} from 'mikro/result'
import {getWakeupCause as nativeGetWakeupCause} from 'native:sleep'
import * as native from 'native:sys'

export function uptime(): {boot: number; rtc: number} {
  return native.uptime()
}

export function setSystemTime(millisSinceEpoch: number): void
export function setSystemTime(date: Date): void
export function setSystemTime(dateOrMillisSinceEpoch: Date | number): void
export function setSystemTime(dateOrMillisSinceEpoch: Date | number): void {
  return native.setTime(
    dateOrMillisSinceEpoch instanceof Date
      ? dateOrMillisSinceEpoch.getTime()
      : dateOrMillisSinceEpoch,
  )
}

export function memoryUsage() {
  return native.memoryUsage()
}

export function jsMemoryUsage() {
  return native.jsMemoryUsage()
}

export function gc() {
  return native.gc()
}

export const version: string = native.version

export const board = native.board

export const firmware = native.firmware

export const deviceId: string = native.deviceId

export function restart(): never {
  return native.restart() as never
}

export function getWakeupCause(): string {
  return nativeGetWakeupCause()
}

export function exit(_exitCode?: number): never {
  return native.restart() as never
}

export function panic(message: string): never {
  throw new PanicError(message)
}

const buildDate = new Date(native.firmware.date)

export class MonotonicTimestamp {
  readonly uptimeMs: number

  private constructor(uptimeMs: number) {
    this.uptimeMs = uptimeMs
  }

  static now(): MonotonicTimestamp {
    return new MonotonicTimestamp(uptime().rtc)
  }

  /** Rehydrate a previously-serialized timestamp. `uptimeMs` must be a
   *  value that originated from `.uptimeMs` on a MonotonicTimestamp taken
   *  within the current RTC reset cycle; values from prior reset cycles
   *  will resolve to meaningless wall-clock times because the RTC counter
   *  reset between then and now. Callers must guard cross-reset-cycle
   *  misuse themselves (e.g. via a cold-boot session id). */
  static fromRtcMs(uptimeMs: number): MonotonicTimestamp {
    return new MonotonicTimestamp(uptimeMs)
  }

  /** Elapsed ms since another MonotonicTimestamp (NTP-independent) */
  since(other: MonotonicTimestamp): number {
    return this.uptimeMs - other.uptimeMs
  }

  /** Resolve to wall-clock epoch ms */
  private resolveMs(): number {
    const elapsed = uptime().rtc - this.uptimeMs
    return Date.now() - elapsed
  }

  wallDate(): Result<Date, 'ClockNotSynced'> {
    const date = new Date(this.resolveMs())
    if (date < buildDate) return err('ClockNotSynced' as const)
    return ok(date)
  }
}
