import {KVError, makeCreateValue, mapKvError} from 'mikro/kv/shared'
import {err, ok} from 'mikro/result'
import {clear, get, info, remove, set, sysClear} from 'native:mikro/nvs_kv'

import type {Result} from '../result/types.js'
import type {KVError as KVErrorType, NvsStorage} from './types.js'

// Loaded in isolation: this file avoids `native:mikro/rtc`, so apps importing
// `mikrojs/kv/nvs` directly don't pay for the RTC backend. `KVError` and
// `makeCreateValue` come from the shared bytecode module at runtime so
// they aren't duplicated across nvs.js and rtc.js.

export {KVError}

// A full clear attempts both stores even if the first fails; the first
// error is returned so a partial wipe surfaces.
function clearStorage(options?: {full?: boolean}): Result<void, KVErrorType> {
  const cleared = clear()
  const sysCleared = options?.full === true ? sysClear() : undefined
  if (!cleared.ok) return err(mapKvError(cleared.error))
  if (sysCleared !== undefined && !sysCleared.ok) return err(mapKvError(sysCleared.error))
  return ok()
}

export const nvsStorage = {
  createValue: makeCreateValue({get, set, remove, clear, info}),
  clear: clearStorage,
  info,
} as NvsStorage
