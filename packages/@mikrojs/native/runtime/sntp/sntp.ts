import {err, ok} from 'mikrojs/result'
import {setTimezone, stop as nativeStop, sync as nativeSync} from 'native:sntp'

import type {Result} from '../result/types.js'
import type {Sntp, SntpError, SntpOptions, SntpSyncResult, SntpSyncResultWithStop} from './types.js'

// native:sntp emits `InitFailed` / `Cancelled` directly; `Timeout` is a
// JS-side variant (the Promise racer below owns the clock).

const DEFAULT_SERVERS = ['pool.ntp.org']
const DEFAULT_TIMEZONE = 'UTC0'
const DEFAULT_TIMEOUT = 60_000

function sync(
  options: SntpOptions & {background: true},
): Promise<Result<SntpSyncResultWithStop, SntpError>>
function sync(
  options?: SntpOptions & {background?: false},
): Promise<Result<SntpSyncResult, SntpError>>
function sync(
  options?: SntpOptions & {background?: boolean},
): Promise<Result<SntpSyncResult | SntpSyncResultWithStop, SntpError>> {
  const servers = options?.servers ?? DEFAULT_SERVERS
  const timezone = options?.timezone ?? DEFAULT_TIMEZONE
  const background = options?.background ?? false
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT

  const startResult = nativeSync(servers, timezone, background)
  if (!startResult.ok) return Promise.resolve(startResult)

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      nativeStop()
      resolve(err({name: 'Timeout' as const, ms: timeout}))
    }, timeout)

    void startResult.value.then((asyncResult) => {
      clearTimeout(timer)
      if (!asyncResult.ok) {
        resolve(asyncResult)
        return
      }
      const result: SntpSyncResult = {time: new Date(asyncResult.value.time)}
      if (background) {
        ;(result as SntpSyncResultWithStop).stop = () => nativeStop()
      }
      resolve(ok(result))
    })
  })
}

const sntp: Sntp = {sync, setTimezone}

export {sntp}
