import {readFile} from 'mikro/fs'
import {sysGet, sysSet} from 'native:mikro/nvs_kv'
import * as native from 'native:mikro/ota'

import {createOta, type OtaStore} from './policy.js'
import type {Ota} from './types.js'

// Policy state, persisted to the mik.sys NVS namespace so the retry budget
// survives a crash-loop and app-level nvsStorage.clear() can't wipe it.
// NVS keys are capped at 15 chars.
// A dropped write cannot be recovered from here, but it must not pass in
// silence: `ota.tries` and `ota.inflight` are the crash-loop latch, so losing
// either hands the retry budget back on every boot and the bound that stops a
// panicking build from being retried forever is gone.
function put(key: string, value: string | number): void {
  const r = sysSet(key, value)
  // eslint-disable-next-line no-console
  if (!r.ok) console.error(`ota: could not persist ${key}`, r.error)
}

const store: OtaStore = {
  getUrl: () => {
    const v = sysGet('ota.url')
    return typeof v === 'string' ? v : undefined
  },
  setUrl: (url) => put('ota.url', url),
  getAttempt: () => {
    const v = sysGet('ota.att')
    return typeof v === 'string' ? v : undefined
  },
  setAttempt: (checksum) => put('ota.att', checksum),
  getTries: () => {
    const v = sysGet('ota.tries')
    return typeof v === 'number' ? v : 0
  },
  setTries: (n) => put('ota.tries', n),
  getBad: () => {
    const v = sysGet('ota.bad')
    return typeof v === 'string' ? v : undefined
  },
  setBad: (checksum) => put('ota.bad', checksum),
  getInFlight: () => sysGet('ota.inflight') === 1,
  setInFlight: (value) => put('ota.inflight', value ? 1 : 0),
}

// Written as a pair to mik.sys by `mikro ota enroll`: the registry url and
// the device credential that authenticates against it.
function bearer(): string | undefined {
  const v = sysGet('ota.credential')
  return typeof v === 'string' ? v : undefined
}

function registry(): string | undefined {
  const v = sysGet('ota.registry')
  return typeof v === 'string' ? v : undefined
}

function readAppVersion(): string | undefined {
  const r = readFile('/app/package.json', 'utf-8')
  if (!r.ok) return undefined
  try {
    const pkg = JSON.parse(r.value) as {version?: unknown}
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

const ota: Ota = createOta({
  native,
  store,
  readAppVersion,
  bearer,
  registry,
})

export {ota}
