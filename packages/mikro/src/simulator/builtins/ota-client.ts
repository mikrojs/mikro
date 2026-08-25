import type {BuiltinDefinition} from './types.js'

// In-memory stub for native:mikro/ota_client. On device this module is the C
// check-in client and update policy (src/mik_ota_client.cpp,
// src/mik_ota_policy.cpp). It must export every name the module exports, or
// `import {ota} from 'mikro/ota'` fails to link: ES imports resolve eagerly, so
// a missing export breaks the app before any of it runs.
//
// `check`/`watch` report plainly that there is no transport rather than
// pretending to run a round. Everything else is simulated: the host has no app
// partition, but the staging -> finish -> reconcile -> confirm/revert sequence
// is the part an app's own update code drives, and it runs here in memory.
// `config()` serves whatever the session's mik.sys `ota.cfg` slot holds.
export const otaClientBuiltin: BuiltinDefinition = {
  source: `
import {sysGet} from 'native:mikro/nvs_kv'
import {readFile} from 'mikro/fs'
import {ok, err} from 'mikro/result'

const UNAVAILABLE = {
  status: 'failed',
  error: {
    name: 'Network',
    message: 'the simulator has no OTA transport; run this on a device',
  },
}

export function check() {
  return Promise.resolve(UNAVAILABLE)
}

export function watch() {
  console.warn('ota: watch() does nothing in the simulator; run this on a device')
  return {stop: () => undefined, setCheckinInterval: () => undefined}
}

export function config() {
  // Unlike the device, the sim slot carries no version stamp, so a stored
  // document is served whatever build wrote it.
  const stored = sysGet('ota.cfg')
  const doc = typeof stored === 'object' && stored !== null ? stored.doc : undefined
  const hasDoc = typeof doc === 'object' && doc !== null
  const defaults = manifestDefaults()
  if (defaults === undefined) {
    if (hasDoc) return doc
    throw new Error(
      'ota.config(): no config to read: this build carries no readable app manifest, ' +
        'so it has no config defaults. Deploy it with \`mikro deploy\`, or run \`mikro dev\`',
    )
  }
  return hasDoc ? {...defaults, ...doc} : {...defaults}
}

// The defaults pack materialized into the running build's manifest, or
// undefined when there is no readable manifest at all. A manifest without
// materialized defaults is an app that declares no config schema, whose config
// is {}, not a failure. Mirrors the device reader (src/mik_ota_config.cpp).
function manifestDefaults() {
  const manifest = readFile('/app/mikro.app.json', 'utf-8')
  if (!manifest.ok) return undefined
  let parsed
  try {
    parsed = JSON.parse(manifest.value)
  } catch {
    return undefined
  }
  const held = parsed === null ? undefined : parsed.configDefaults
  return typeof held === 'object' && held !== null ? held : {}
}

export function bearer() {
  const key = sysGet('ota.updateKey')
  return typeof key === 'string' && key !== '' ? key : undefined
}

export function registry() {
  const url = sysGet('ota.registry')
  return typeof url === 'string' && url !== '' ? url : undefined
}

// ── the in-memory build state ────────────────────────────────────────────────

let current = {checksum: undefined, version: undefined, trial: false}
let previous = undefined // rollback target
let staged = undefined // {checksum} pending a next-boot install
let report = {reverted: false} // pending reconcile report

function install(checksum) {
  previous = current.checksum === undefined ? undefined : {checksum: current.checksum}
  current = {checksum, version: current.version, trial: true}
}

export function running() {
  return {checksum: current.checksum, version: current.version, trial: current.trial}
}

export function confirm() {
  current = {checksum: current.checksum, version: current.version, trial: false}
}

export function revert() {
  if (previous === undefined) {
    return err({name: 'InstallFailed', message: 'no rollback target', kind: 'transient'})
  }
  current = {checksum: previous.checksum, version: current.version, trial: false}
  previous = undefined
  report = {reverted: true}
  return ok()
}

export function reconcile() {
  // Simulate a boot: apply any staged next-boot build, then hand back and clear
  // the pending report.
  if (staged !== undefined) {
    install(staged.checksum)
    report = {installed: staged.checksum, reverted: false}
    staged = undefined
  }
  const out = report
  report = {reverted: false}
  return out
}

export function parseOffer(raw, opts) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const url = raw.url
  const checksum = raw.checksum
  const size = raw.size
  if (typeof url !== 'string' || url === '') return undefined
  if (typeof checksum !== 'string' || checksum.length !== 64) return undefined
  if (typeof size !== 'number' || !(size > 0)) return undefined
  const insecure = opts !== undefined && opts.allowInsecure === true
  if (!url.startsWith('https://') && !(insecure && url.startsWith('http://'))) return undefined
  return {url, checksum, size}
}

export function applyOffer(offer, download, options) {
  if (current.checksum === offer.checksum) return Promise.resolve(ok('current'))
  if (current.trial) return Promise.resolve(ok('trial-pending'))

  let written = 0
  const update = {
    resumeOffset: 0,
    write(bytes) {
      written += bytes.length
      if (written > offer.size) {
        return err({name: 'TooLarge', message: 'wrote past the offered size'})
      }
      return ok()
    },
  }

  return download(update).then((result) => {
    if (!result.ok) {
      return err({name: 'DownloadFailed', message: result.error.message})
    }
    if (written !== offer.size) {
      return err({
        name: 'InstallFailed',
        message: 'size mismatch: ' + written + ' != ' + offer.size,
        kind: 'corrupt',
      })
    }
    const installNow = options !== undefined && options.install === 'now'
    if (installNow) {
      install(offer.checksum)
      report = {installed: offer.checksum, reverted: false}
    } else {
      staged = {checksum: offer.checksum}
    }
    return ok('staged')
  })
}
`,
}
