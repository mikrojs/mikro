import type {Result} from '../result/types.js'

export interface SntpOptions {
  /** NTP server(s). Default: ['pool.ntp.org'] */
  servers?: string[]
  /** POSIX TZ string, e.g. 'CET-1CEST,M3.5.0,M10.5.0/3'. Default: 'UTC0' */
  timezone?: string
  /** Milliseconds before timeout. Default: 60000 */
  timeout?: number
}

export interface SntpSyncResult {
  time: Date
}

export interface SntpSyncResultWithStop extends SntpSyncResult {
  stop: () => void
}

export type SntpError =
  | {name: 'InitFailed'; message: string}
  | {name: 'Timeout'; ms: number}
  | {name: 'Cancelled'}

export interface Sntp {
  sync(
    options: SntpOptions & {background: true},
  ): Promise<Result<SntpSyncResultWithStop, SntpError>>
  sync(options?: SntpOptions & {background?: false}): Promise<Result<SntpSyncResult, SntpError>>
  sync(
    options?: SntpOptions & {background?: boolean},
  ): Promise<Result<SntpSyncResult | SntpSyncResultWithStop, SntpError>>

  /** Set the POSIX timezone string independently of sync. */
  setTimezone(tz: string): void
}

export declare const sntp: Sntp
