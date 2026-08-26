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
// `config()` serves whatever the session's mik.sys `ota.cfg` slot holds, and
// `applyConfig()` is what puts a document there.
export const otaClientBuiltin: BuiltinDefinition = {
  source: `
import {sysGet, sysRemove, sysSet} from 'native:mikro/nvs_kv'
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
  if (hasDoc) markConfigRead()
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
  const parsed = manifest()
  if (parsed === undefined) return undefined
  const held = parsed.configDefaults
  return typeof held === 'object' && held !== null ? held : {}
}

// The running app's version, which is what decides where a delivered document
// belongs. The manifest carries the same value the device reads out of
// /app/package.json.
function manifestVersion() {
  const parsed = manifest()
  const version = parsed === undefined ? undefined : parsed.version
  return typeof version === 'string' && version !== '' ? version : undefined
}

function manifest() {
  const text = readFile('/app/mikro.app.json', 'utf-8')
  if (!text.ok) return undefined
  let parsed
  try {
    parsed = JSON.parse(text.value)
  } catch {
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null ? parsed : undefined
}

export function bearer() {
  const key = sysGet('ota.updateKey')
  return typeof key === 'string' && key !== '' ? key : undefined
}

export function registry() {
  const url = sysGet('ota.registry')
  return typeof url === 'string' && url !== '' ? url : undefined
}

// ── config delivery ──────────────────────────────────────────────────────────
// Mirrors src/mik_ota_config.cpp. A sim run is one boot, so a trial is armed
// and can be adopted here, but never burned down to a rollback: that needs the
// power cycles only a device has.

export function parseConfig(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const version = raw.version
  // Bounded by the buffers the device stores them in. A truncated rev would
  // never match the one the registry issued, so it is rejected, not cut.
  if (typeof version !== 'string' || version === '' || version.length > 31) return undefined
  const rev = raw.rev
  const hasRev = rev !== undefined && rev !== null
  if (hasRev && (typeof rev !== 'string' || rev.length > 64)) return undefined
  const doc = raw.doc
  const hasDoc = doc !== undefined && doc !== null
  // The document is spread over the defaults top level: anything that is not a
  // plain object has no keys to spread. An absent doc is the clear.
  if (hasDoc && (typeof doc !== 'object' || Array.isArray(doc))) return undefined
  const out = {version}
  if (hasRev && rev !== '') out.rev = rev
  if (hasDoc) out.doc = doc
  return out
}

export function applyConfig(config, options) {
  const parsed = parseConfig(config)
  if (parsed === undefined) return 'invalid'
  const version = manifestVersion()
  // Which slot the document belongs in is unknown without the running version,
  // and storing it in either would be a guess the reader drops in silence.
  if (version === undefined) return 'failed'

  if (parsed.version !== version) {
    // Stamped for another release: it applies with the build it names.
    if (parsed.doc === undefined) sysRemove('ota.cfgNext')
    else sysSet('ota.cfgNext', parsed)
    return 'staged'
  }

  const held = sysGet('ota.cfg')
  const heldCfg = typeof held === 'object' && held !== null ? held : undefined

  if (parsed.doc === undefined) {
    // A rev riding along does not turn a clear into a document.
    sysRemove('ota.cfgTrial')
    sysRemove('ota.cfgErr')
    sysRemove('ota.cfgPrev')
    if (heldCfg === undefined) return 'unchanged'
    sysRemove('ota.cfg')
    return 'cleared'
  }

  // An identical document must cost nothing: re-storing it would put a document
  // that already passed its trial back on trial. The rev counts as part of it.
  if (heldCfg !== undefined && sameConfig(heldCfg, parsed)) return 'unchanged'

  // The document it replaces is the rollback baseline: a schema-valid value can
  // still be fatal to the app.
  if (heldCfg === undefined) sysRemove('ota.cfgPrev')
  else sysSet('ota.cfgPrev', heldCfg)
  sysSet('ota.cfg', parsed)
  let trialBoots = 1
  if (options !== undefined && typeof options.trialBoots === 'number' && options.trialBoots >= 1) {
    trialBoots = options.trialBoots
  }
  sysSet('ota.cfgTrial', {left: trialBoots, read: false})
  sysRemove('ota.cfgErr')
  return 'applied'
}

export function configState() {
  const out = {}
  const report = sysGet('ota.cfgErr')
  const hasError =
    typeof report === 'object' && report !== null && typeof report.rev === 'string'
  if (hasError) {
    out.error = {
      rev: report.rev,
      message: typeof report.message === 'string' ? report.message : '',
    }
  }
  // After a rollback the FAILED document's rev is the one to echo, not the
  // restored one's: that is what stops the registry serving it again.
  const held = sysGet('ota.cfg')
  const heldRev =
    typeof held === 'object' && held !== null && typeof held.rev === 'string' ? held.rev : ''
  const rev = hasError ? report.rev : heldRev
  if (rev !== '') out.rev = rev
  return out
}

function sameConfig(held, next) {
  const heldRev = typeof held.rev === 'string' ? held.rev : ''
  const nextRev = typeof next.rev === 'string' ? next.rev : ''
  if (heldRev !== nextRev || held.version !== next.version) return false
  return JSON.stringify(held.doc) === JSON.stringify(next.doc)
}

// A document the app has read is a document the app ran with, which is what a
// later confirm() adopts on.
function markConfigRead() {
  const trial = sysGet('ota.cfgTrial')
  if (typeof trial !== 'object' || trial === null || trial.read === true) return
  sysSet('ota.cfgTrial', {left: trial.left, read: true})
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
  // The version falls back to the manifest, the way mik__ota_policy_running
  // falls back to read_app_version: an app needs it to stamp what it delivers.
  const version = current.version === undefined ? manifestVersion() : current.version
  return {checksum: current.checksum, version, trial: current.trial}
}

export function confirm() {
  current = {checksum: current.checksum, version: current.version, trial: false}
  // One confirm settles both trials, as on device (mik__ota_policy_confirm).
  // The config trial waits additionally for the app to have read the document.
  const trial = sysGet('ota.cfgTrial')
  const armed = typeof trial === 'object' && trial !== null
  if (!armed || trial.read === true) {
    sysRemove('ota.cfgPrev')
    sysRemove('ota.cfgTrial')
  }
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
