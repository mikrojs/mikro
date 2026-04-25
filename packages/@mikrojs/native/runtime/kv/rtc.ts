import {KVError, makeCreateValue} from 'mikrojs/kv/shared'
import {clear, get, info, remove, set} from 'native:rtc'

import type {RtcStorage} from './types.js'

// Loaded in isolation: this file avoids `native:nvs_kv`, so apps importing
// `mikrojs/kv/rtc` directly don't pay for the NVS backend. `KVError` and
// `makeCreateValue` come from the shared bytecode module at runtime so
// they aren't duplicated across nvs.js and rtc.js.

export {KVError}

export const rtcStorage = {
  createValue: makeCreateValue({get, set, remove, clear, info}),
  clear,
  info,
} as RtcStorage
