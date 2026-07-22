import {err, ok} from 'mikro/result'

import type {Result} from '../result/types.js'
import type {
  ApplyOutcome,
  DownloadFn,
  InstallOptions,
  InstallOutcome,
  Offer,
  Ota,
  OtaDownloadError,
  OtaError,
  OtaInstallError,
  RunningBuild,
  Update,
} from './types.js'

/** The native:mikro/ota contract (ESP-only C module; stubbed on host). */
export interface NativeOta {
  stageBegin(
    checksum: string,
    size: number,
  ): {ok: true; resumeOffset: number} | {ok: false; error: string}
  // No `kind` here, unlike stageFinish: every write failure is a storage
  // problem and maps to StagingFull, so there is nothing to discriminate on.
  stageWrite(bytes: Uint8Array): {ok: true} | {ok: false; error: string}
  stageFinish(
    trialBoots: number,
    requireConfirm: boolean,
    installNow: boolean,
  ): {ok: true} | {ok: false; error: string; kind: 'corrupt' | 'transient' | 'oom'}
  stageAbort(): void
  markValid(): void
  revert(): {ok: true} | {ok: false; error: string}
  running(): {checksum?: string; trial: boolean}
  reconcile(): {
    installed?: string
    reverted: boolean
    diagnostic?: {reason: string; detail?: string}
  }
}

/** Crash-loop-safe policy state, persisted to NVS with short keys. */
export interface OtaStore {
  getUrl(): string | undefined
  setUrl(url: string): void
  /** Checksum the retry budget is currently counting against. */
  getAttempt(): string | undefined
  setAttempt(checksum: string): void
  getTries(): number
  setTries(n: number): void
  getBad(): string | undefined
  setBad(checksum: string): void
  /** True while an install attempt is running. Still true at boot means the
   *  last one never returned, i.e. it crashed the device. */
  getInFlight(): boolean
  setInFlight(value: boolean): void
}

interface OtaDeps {
  native: NativeOta
  store: OtaStore
  /** Live app version from /app/package.json, or undefined if unreadable. */
  readAppVersion(): string | undefined
  /** The check-in bearer: the device credential from the system store, or
   *  undefined on an un-enrolled device. */
  bearer(): string | undefined
  /** The registry url the credential was minted against, or undefined. */
  registry(): string | undefined
}

/** Number of staging attempts for one url before a checksum is abandoned. */
const MAX_TRIES = 3

/** Validate an untrusted registry value into an `Offer`, or `undefined`. */
export function parseOffer(raw: unknown, opts?: {allowInsecure?: boolean}): Offer | undefined {
  // null/undefined is the registry's "no update available" signal, not a
  // malformed offer, so return quietly without a warning.
  if (raw === null || raw === undefined) return undefined
  const reject = (reason: string): undefined => {
    // eslint-disable-next-line no-console
    console.warn(`ota: ignoring offer (${reason})`)
    return undefined
  }
  if (typeof raw !== 'object') return reject('not an object')
  const o = raw as Record<string, unknown>
  // No url is "no update", not a malformed offer: a check-in with nothing newer
  // still returns a body when the registry has something else to say — a name to
  // adopt, say — and the reference client reads that before parseOffer. Warn
  // only when a url is present but unusable, so a dashboard rename that coincides
  // with "up to date" does not log a misleading warning on every device.
  if (o.url === undefined) return undefined
  if (typeof o.url !== 'string') return reject('missing url')
  // https is required so the device never downloads executable bytecode over
  // plaintext; allowInsecure (dev only) also permits http for local registries.
  const schemeOk =
    o.url.startsWith('https://') || (opts?.allowInsecure === true && o.url.startsWith('http://'))
  // Only the path has to name a .tgz. A registry is free to hang a query on the
  // url — a signed-url registry puts an expiry and signature there — and the
  // device treats the whole string as opaque, so rejecting on the query would
  // forbid that for no gain.
  const pathEnd = o.url.search(/[?#]/)
  const urlPath = pathEnd < 0 ? o.url : o.url.slice(0, pathEnd)
  if (!schemeOk || !urlPath.endsWith('.tgz')) {
    return reject(opts?.allowInsecure ? 'url must be an http(s) .tgz' : 'url must be an https .tgz')
  }
  if (typeof o.checksum !== 'string' || o.checksum.length === 0) return reject('missing checksum')
  // Must be a positive integer: a negative size fails the first write with
  // TooLarge, and 0 disables the cap on both sides, leaving the download
  // unbounded.
  if (typeof o.size !== 'number' || !Number.isInteger(o.size) || o.size <= 0) {
    return reject('invalid size')
  }
  // The url's host is not checked. The offer arrives in an authenticated
  // check-in response from the enrolled registry, so the registry is trusted to
  // name where the build lives — a CDN or object store on another host, a signed
  // url with its own query. Integrity is the checksum, verified over the whole
  // download before install, so a wrong host yields a failed install, never a
  // bad one; and the credential is the caller's to confine (the reference client
  // attaches it only when the url is same-origin with the registry).
  return {url: o.url, checksum: o.checksum, size: o.size}
}

function makeUpdate(native: NativeOta, size: number | undefined, resumeOffset: number): Update {
  let written = resumeOffset
  return {
    resumeOffset,
    write(bytes) {
      if (size !== undefined && written + bytes.length > size) {
        return err({name: 'TooLarge' as const, message: `build exceeds offered size ${size}`})
      }
      const r = native.stageWrite(bytes)
      if (!r.ok) return err({name: 'StagingFull' as const, message: r.error})
      written += bytes.length
      return ok()
    },
    finish(options) {
      const r = native.stageFinish(
        options?.trialBoots ?? 1,
        options?.requireConfirm ?? false,
        options?.install === 'now',
      )
      if (r.ok) return ok()
      return err({name: 'InstallFailed' as const, kind: r.kind, message: r.error})
    },
    abort() {
      native.stageAbort()
    },
  }
}

/** True if the failure means the bytes are bad and must not be retried. */
function isAbandon(e: OtaError): boolean {
  return e.name === 'InstallFailed' && e.kind === 'corrupt'
}

export function createOta(deps: OtaDeps): Ota {
  const {native, store, readAppVersion} = deps

  function beginUpdate(options: {checksum: string; size: number}) {
    const r = native.stageBegin(options.checksum, options.size)
    if (!r.ok) return err({name: 'StagingFailed' as const, message: r.error})
    return ok(makeUpdate(native, options.size, r.resumeOffset))
  }
  // beginUpdate stays internal: staging is only ever driven through the policy.

  function reconcile(): InstallOutcome {
    // Give the budget back once per boot. Everything it counts is transient
    // (OOM, a truncated download), and a reboot is the one signal available
    // here that conditions may have changed — there is no clock to back off
    // against. Without this the budget is a permanent latch: three OOM
    // failures would strand the device on the old build forever, even once
    // free heap recovered.
    //
    // Unless the last attempt crashed. A native OOM panics into a restart, so
    // an unconditional reset zeroes the count on exactly the failure the budget
    // exists to bound, and the device reboots into the same attempt forever.
    // The in-flight flag is still set only in that case, so the crashed attempt
    // keeps its bump and MAX_TRIES eventually binds.
    if (store.getInFlight()) store.setInFlight(false)
    else store.setTries(0)
    const r = native.reconcile()
    const out: InstallOutcome = {reverted: r.reverted}
    if (r.installed !== undefined) out.installed = r.installed
    if (r.diagnostic !== undefined) out.lastInstall = r.diagnostic
    return out
  }

  function running(): RunningBuild {
    const r = native.running()
    const out: RunningBuild = {trial: r.trial}
    if (r.checksum !== undefined) out.checksum = r.checksum
    const v = readAppVersion()
    if (v !== undefined) out.version = v
    return out
  }

  function revert(): Result<void, OtaInstallError> {
    const r = native.revert()
    if (r.ok) return ok()
    return err({name: 'InstallFailed' as const, kind: 'transient' as const, message: r.error})
  }

  async function applyOffer(
    offer: Offer,
    download: DownloadFn,
    options?: InstallOptions,
  ): Promise<Result<ApplyOutcome, OtaError>> {
    const run = native.running()
    // (a) a trial is unresolved. Reported distinctly because the caller's
    // response differs from every other skip: the build on trial still needs
    // confirming, and treating this like "nothing to do" lets the trial lapse
    // and roll back a healthy build just because a newer one was published.
    if (run.trial) return ok('trial-pending')
    // (b) already running this build
    if (offer.checksum === run.checksum) return ok('current')
    // (d) device has given up on this build
    if (offer.checksum === store.getBad()) return ok('abandoned')
    // (e) retry budget, keyed on url *and* checksum. Exhausting it only stops
    // attempts against this exact build at this exact url; the checksum is not
    // abandoned, because everything counted here is transient by construction
    // (a corrupt build is abandoned at (h) instead). Marking it bad would be
    // unrecoverable: check (d) runs before this, so re-publishing the same
    // build at a fresh url could never revive it, and nothing clears `bad`. A
    // device on flaky wifi would permanently lose a good build after three
    // failed downloads.
    //
    // The checksum has to be part of the key because a registry that serves a
    // stable url ("/latest.tgz", re-pointed on publish) would otherwise never
    // reset: three failures against the old build would skip every future one
    // at that url, permanently, since the reset on success is unreachable.
    if (offer.url !== store.getUrl() || offer.checksum !== store.getAttempt()) {
      store.setUrl(offer.url)
      store.setAttempt(offer.checksum)
      store.setTries(0)
    }
    const tries = store.getTries()
    if (tries >= MAX_TRIES) return ok('exhausted')
    // (f) bump before the attempt, so a crash mid-attempt still counts — the
    // flag is what makes that true across a reboot (see reconcile). The finally
    // clears it on every ordinary exit, and deliberately does not run when the
    // attempt takes the device down with it.
    store.setTries(tries + 1)
    store.setInFlight(true)
    try {
      return await attempt(offer, download, options)
    } finally {
      store.setInFlight(false)
    }
  }

  async function attempt(
    offer: Offer,
    download: DownloadFn,
    options?: InstallOptions,
  ): Promise<Result<ApplyOutcome, OtaError>> {
    // (g) stage, download, verify
    const begun = beginUpdate({checksum: offer.checksum, size: offer.size})
    if (!begun.ok) return err(begun.error)
    const update = begun.value
    // The download callback is the app's transport code. A failure there (network,
    // a write rejection) is transient: keep the bumped tries so it retries next time,
    // and do NOT abandon the checksum (that is only for a corrupt build).
    const downloaded = await download(update)
    if (!downloaded.ok) {
      update.abort()
      const downloadError: OtaDownloadError = {
        name: 'DownloadFailed',
        message: downloaded.error.message,
      }
      return err(downloadError)
    }
    // (h) a corrupt build is the one thing worth abandoning: the same bytes will
    // fail identically forever. Abort first, or the verified-bad staging file
    // (up to the whole build) sits on the app partition until some later offer
    // happens to reclaim it.
    const finished = update.finish(options)
    if (!finished.ok) {
      if (isAbandon(finished.error)) {
        update.abort()
        store.setBad(offer.checksum)
      }
      return err(finished.error)
    }
    store.setTries(0)
    return ok('staged')
  }

  return {
    reconcile,
    running,
    parseOffer,
    applyOffer,
    confirm: () => native.markValid(),
    revert,
    bearer: deps.bearer,
    registry: deps.registry,
  }
}
