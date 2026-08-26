// `mikro/ota` — the low-level update surface, for an app that talks to its own
// registry. The built-in client (`mikro/ota/client`) covers the ordinary case
// and does not go through here.
//
// Every member is the C policy (src/mik_ota_policy.cpp): the retry budget, the
// trial gates and the staging session all live there, so this module and the
// built-in client cannot disagree about the crash-loop latch they share.

import {config} from 'mikro/ota/config'
import {
  applyConfig,
  applyOffer,
  bearer,
  configState,
  confirm,
  parseConfig,
  parseOffer,
  reconcile,
  registry,
  revert,
  running,
} from 'native:mikro/ota_client'

import type {Ota} from './types.js'

const ota: Ota = {
  reconcile,
  running,
  parseOffer,
  applyOffer,
  confirm,
  revert,
  bearer,
  registry,
  config,
  parseConfig,
  applyConfig,
  configState,
}

export {ota}
