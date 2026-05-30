import {KVError, makeCreateValue} from 'mikro/kv/shared'
import {clear, get, info, remove, set} from 'native:nvs_kv'

import type {NvsStorage} from './types.js'

// Loaded in isolation: this file avoids `native:rtc`, so apps importing
// `mikrojs/kv/nvs` directly don't pay for the RTC backend. `KVError` and
// `makeCreateValue` come from the shared bytecode module at runtime so
// they aren't duplicated across nvs.js and rtc.js.

export {KVError}

export const nvsStorage = {
  createValue: makeCreateValue({get, set, remove, clear, info}),
  clear,
  info,
} as NvsStorage
