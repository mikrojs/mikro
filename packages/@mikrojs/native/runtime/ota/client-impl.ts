// Internal: the OTA client state machine behind `mikro/ota/client`. Bundled
// into ota/client.js; not exposed as its own subpath. Exists as a seam so host
// tests can drive the whole client against fakes — no hardware, no registry,
// no real restart.

import type {Request, RequestError} from 'mikro/http/helpers'
import {err, ok} from 'mikro/result'

import type {CborError} from '../cbor/types.js'
import type {Result} from '../result/types.js'
import type {DeviceName} from '../sys/types.js'
import type {Diagnostic, Offer, Ota, OtaError, Update} from './types.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Immutable facts about this device and the firmware under it. */
export interface DeviceIdentity {
  deviceId: string
  /** Firmware version string, and the hash of that image. A build published
   *  against a different firmware is withheld rather than offered. */
  firmware: string
  firmwareHash: string
  /** QuickJS bytecode version the linked engine reads; a build compiled for
   *  another one cannot run here. */
  bytecode: number
}

/**
 * Every effect the client can have on the world, in one record. Nothing below
 * `createOtaClient` reaches for a runtime import — effects arrive here, so the
 * policy can run against a fake with no hardware and no risk of a real
 * restart().
 */
export interface ClientIo {
  /** Wall-clock delay. The only clock the client has. */
  sleep(ms: number): Promise<void>
  /** HTTP. The only network the client has. */
  request: Request
  /** Uniform [0, 1). Injected so tests can pin the jitter. */
  random(): number
  /** Serial diagnostics. Format string and args pass through untouched. */
  log(level: LogLevel, format: string, ...args: unknown[]): void
  /** CBOR codec for the check-in wire. */
  encode(value: unknown): Result<Uint8Array, CborError>
  decode(data: Uint8Array): Result<unknown, CborError>

  /** The `mikro/ota` policy surface (staging, trials, retry budgets). */
  ota: Ota
  identity(): DeviceIdentity
  /** Bytes free on the partition a build is staged onto, or undefined when the
   *  platform cannot report it. */
  storageFree(): number | undefined
  deviceName(): DeviceName
  setDeviceName(name: DeviceName): void
  restart(): never
}

export interface CheckOptions {
  /** Budget for the check-in round trip. Default 10s. */
  checkinTimeoutMs?: number
  /** Budget for the build download. Separate from the check-in's because it is
   *  a total wallclock deadline that cancels the transfer mid-stream, and an
   *  image needs orders of magnitude more of it than a check-in body does.
   *  Default 5m. */
  downloadTimeoutMs?: number
  /** Require a completed check-in (via `ota.confirm()`, which the client fires
   *  itself) before an installed build is kept. Default true. */
  requireConfirm?: boolean
  /** Clean boots a trial may consume before an unconfirmed build reverts.
   *  A deep-sleep wake counts as a clean boot, so wake-cycle devices on flaky
   *  networks should raise this above the default 1. */
  trialBoots?: number
}

/** Runs after its round settles — after the check and any download, and before
 *  an auto-restart — so the network brought up in `beforeCheck` can go down. */
export type Teardown = () => void | Promise<void>

export interface WatchOptions extends CheckOptions {
  /** Steady interval between rounds, end-of-round to start-of-next. Default 30m. */
  checkinIntervalMs?: number
  /** Delay before the first round. Default 5s. */
  initialDelayMs?: number
  /** Interval after a failed round, capped at `checkinIntervalMs`. Default 1m. */
  retryAfterFailureMs?: number
  /** Spread every scheduled sleep by ±10%, so a fleet that lost power together
   *  does not check in phase-locked forever. Default true; pass false for
   *  exact intervals (a demo watching for the update to land, a single
   *  device where the spread only delays it). */
  jitter?: boolean
  /** Bring the network up for one round. `err` skips the round (retried at the
   *  failure interval) and no teardown runs — partial setup is the hook's own
   *  job to unwind. State shared with the teardown stays in this one scope. */
  beforeCheck?(): Promise<Result<Teardown, unknown>>
}

export interface Watcher {
  /** Prevent future rounds and cancel the pending sleep. An in-flight round
   *  completes, but a build it stages no longer auto-restarts — it stays armed
   *  for the next natural reboot. */
  stop(): void
}

/** Why an offered build was not armed. Each is the policy working as intended;
 *  the distinction is logged and returned because the app's next move differs. */
export type DeclineReason =
  | 'trial-pending'
  | 'current'
  | 'abandoned'
  | 'exhausted'
  | 'download-failed'
  | 'install-failed'

/** The check-in never completed. */
export type CheckError = RequestError | CborError | {name: 'Status'; status: number}

export type CheckResult =
  /** Build downloaded, verified, and armed. The app restarts when ready. */
  | {status: 'staged'; offer: Offer}
  | {status: 'up-to-date'}
  /** An offer arrived but was not armed. */
  | {status: 'not-staged'; reason: DeclineReason; error?: OtaError}
  /** Transient: the check-in did not complete, so the running trial (if any)
   *  was not confirmed. */
  | {status: 'failed'; error: CheckError}
  /** The registry rejected the update key (HTTP 401). Permanent until
   *  re-enrollment over the cable. */
  | {status: 'unauthorized'}
  | {status: 'not-enrolled'}

export interface OtaClient {
  check(options?: CheckOptions): Promise<CheckResult>
  watch(options?: WatchOptions): Watcher
}

const DEFAULT_CHECKIN_TIMEOUT_MS = 10_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000
const DEFAULT_INTERVAL_MS = 30 * 60_000
const DEFAULT_INITIAL_DELAY_MS = 5_000
const DEFAULT_RETRY_MS = 60_000

/** What the watch loop does after a round: retry at the shortened interval, or
 *  wait the full one. Deliberately not "did the check-in succeed" — a rejected
 *  update key also waits the full interval (a dead key mustn't hammer the
 *  registry every retry interval forever). */
type NextRound = 'soon' | 'later'

interface Enrollment {
  registryUrl: string
  bearer: string
}

export function createOtaClient(io: ClientIo): OtaClient {
  // One check at a time: staging is a single native session, and two
  // interleaved check-ins would corrupt it. Later calls queue behind the
  // running one; each still gets its own result.
  let chain: Promise<unknown> = Promise.resolve()

  // reconcile() clears its report as it reads, so it runs once per boot and
  // the report is held here until a check-in actually delivers it — a failed
  // first check-in no longer loses it.
  let reconciled = false
  let lastInstall: Diagnostic | undefined

  let warnedInsecure = false

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function enrollment(): Enrollment | undefined {
    // Written as a pair over the cable by `mikro ota enroll`; enrollment is the
    // opt-in. Update keys never arrive over the network.
    const registryUrl = io.ota.registry()
    const bearer = io.ota.bearer()
    if (registryUrl === undefined || bearer === undefined) return undefined
    return {registryUrl, bearer}
  }

  function reconcileOnce(): void {
    if (reconciled) return
    reconciled = true
    const report = io.ota.reconcile()
    lastInstall = report.lastInstall
    if (report.reverted) {
      io.log('warn', 'ota: previous update failed its trial and was rolled back')
    }
    if (report.installed) {
      io.log('info', 'ota: installed build %s on this boot', report.installed.slice(0, 12))
    }
  }

  async function runCheck(enrolled: Enrollment, options: CheckOptions): Promise<CheckResult> {
    const {registryUrl, bearer} = enrolled
    const allowInsecure = isPrivateHttp(registryUrl)
    if (allowInsecure && !warnedInsecure) {
      // Every boot, not once at enrollment: a device that quietly runs a
      // forgeable update channel should say so for as long as it does.
      warnedInsecure = true
      io.log(
        'warn',
        'ota: registry is http:// on a private network — updates are NOT authenticated',
      )
    }
    reconcileOnce()

    const running = io.ota.running()
    const identity = io.identity()
    const named = io.deviceName()
    const free = io.storageFree()
    // The shape is a contract with the registry's /api/v1/checkin: these are
    // the inputs it arbitrates an offer from. Optional keys are omitted, not
    // sent as undefined — the registry reads an absent `free` as "no figure to
    // report", and JSON clients drop the key the same way.
    const report = {
      ...identity,
      running,
      // The name pair: `[rev]` when cleared, `[rev, name]` otherwise. Sent
      // every time so a lost response settles on the next check-in.
      name: named.name === undefined ? [named.rev] : [named.rev, named.name],
      ...(free === undefined ? {} : {free}),
      ...(lastInstall === undefined ? {} : {lastInstall}),
    }
    io.log(
      'debug',
      'ota: checking %s (running %s v%s, bytecode %d, fw %s)',
      `${registryUrl}/api/v1/checkin`,
      running.checksum?.slice(0, 12) ?? 'none',
      running.version ?? '?',
      identity.bytecode,
      identity.firmware,
    )

    const encoded = io.encode(report)
    if (!encoded.ok) {
      io.log('error', 'ota: could not encode the check-in report', encoded.error)
      return {status: 'failed', error: encoded.error}
    }
    const res = await io.request(`${registryUrl}/api/v1/checkin`, {
      method: 'POST',
      headers: {
        'content-type': 'application/cbor',
        accept: 'application/cbor',
        authorization: `Bearer ${bearer}`,
      },
      timeoutMs: options.checkinTimeoutMs ?? DEFAULT_CHECKIN_TIMEOUT_MS,
      body: encoded.value,
    })
    if (!res.ok) {
      io.log('error', 'ota: checkin failed', res.error)
      return {status: 'failed', error: res.error}
    }
    const response = res.value
    if (response.status === 401) {
      // The update key no longer authenticates (rotated, device deleted).
      // Only a 401 means this. There is no fallback secret — re-enroll over
      // the cable. Release the connection before returning.
      await response.close()
      io.log(
        'error',
        'ota: registry rejected the update key; re-enroll with `mikro ota enroll --re-enroll`',
      )
      return {status: 'unauthorized'}
    }
    if (response.status === 415) {
      // The wire is CBOR-only by design; there is no JSON fallback to hide a
      // registry that predates it.
      await response.close()
      io.log(
        'error',
        'ota: registry does not accept CBOR check-ins; upgrade the registry to a version that supports application/cbor',
      )
      return {status: 'failed', error: {name: 'Status', status: 415}}
    }
    if (!response.ok) {
      // Release the connection before the heap-sensitive image request — an
      // abandoned response holds its native slot and TLS buffers until its
      // timeout fires.
      await response.close()
      io.log('error', 'ota: checkin returned status %d', response.status)
      return {status: 'failed', error: {name: 'Status', status: response.status}}
    }
    const raw = await response.bytes()
    if (!raw.ok) {
      io.log('error', 'ota: reading the checkin response failed', raw.error)
      return {status: 'failed', error: raw.error}
    }
    const body = io.decode(raw.value)
    if (!body.ok) {
      io.log('error', 'ota: invalid checkin response body', body.error)
      return {status: 'failed', error: body.error}
    }

    // The check-in completed: the cached install report is delivered.
    lastInstall = undefined

    // Confirm before applying: a completed check-in is the whole health signal
    // requireConfirm waits for, whether or not an offer follows — and resolving
    // the trial now lets an offer published during it stage in this same pass
    // (applyOffer skips every offer while a trial is unresolved).
    if (running.trial) {
      io.log('info', 'ota: check-in completed — confirming this build as healthy')
    }
    io.ota.confirm()

    const renamed = nameFrom(body.value)
    if (renamed !== undefined) {
      io.setDeviceName(renamed)
      io.log('info', 'ota: registry renamed this device to %s', renamed.name ?? '(no name)')
    }

    const offer = io.ota.parseOffer(body.value, {allowInsecure})
    if (offer === undefined) {
      io.log('debug', 'ota: up to date, running the latest build')
      return {status: 'up-to-date'}
    }
    io.log(
      'info',
      'ota: update available (%s, %d bytes); downloading',
      offer.checksum.slice(0, 12),
      offer.size,
    )
    const applied = await io.ota.applyOffer(
      offer,
      (update) => download(enrolled, options, offer, update),
      {
        requireConfirm: options.requireConfirm ?? true,
        trialBoots: options.trialBoots ?? 1,
      },
    )
    if (!applied.ok) {
      const reason: DeclineReason =
        applied.error.name === 'DownloadFailed' ? 'download-failed' : 'install-failed'
      io.log('error', 'ota: update failed', applied.error)
      return {status: 'not-staged', reason, error: applied.error}
    }
    if (applied.value === 'staged') {
      io.log('info', 'ota: download verified and staged')
      return {status: 'staged', offer}
    }
    // Not staged, not an error — applyOffer declined the offer:
    //   current       already running this build
    //   trial-pending the running build hasn't resolved its trial (nearly
    //                 unreachable: the confirm above resolves it first)
    //   abandoned     the build is corrupt and won't be retried
    //   exhausted     the retry budget for this build is spent until next boot
    io.log('info', 'ota: offer not staged (%s)', applied.value)
    return {status: 'not-staged', reason: applied.value}
  }

  /** The download pump: stream the build straight into the staging area,
   *  resuming an interrupted transfer with a Range request. Chunked on purpose:
   *  buffering the whole build would put ~2x its size on the heap. */
  async function download(
    enrolled: Enrollment,
    options: CheckOptions,
    offer: Offer,
    update: Update,
  ): Promise<Result<void, {message: string}>> {
    const from = update.resumeOffset
    // Already complete: a finish that failed transiently leaves every byte on
    // flash and the offer pending, so resuming would ask for `bytes=<size>-`
    // and take the 416 as a failed download forever. Hand it straight back to
    // re-verify.
    if (from >= offer.size) return ok()
    if (from > 0) {
      io.log('info', 'ota: resuming download from byte %d of %d', from, offer.size)
    }
    // Same-origin only. `offer.url` may legitimately point at another host (a
    // CDN, an object store), so the update key goes out only when the download
    // is on the registry's own origin. A build fetched elsewhere is a public
    // artifact the checksum vouches for; a store that needs auth carries it in
    // a signed url instead.
    const headers: Record<string, string> = {}
    if (from > 0) headers.range = `bytes=${from}-`
    if (sameOrigin(offer.url, enrolled.registryUrl)) {
      headers.authorization = `Bearer ${enrolled.bearer}`
    }
    const res = await io.request(offer.url, {
      headers,
      timeoutMs: options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    })
    if (!res.ok) {
      return err({message: `download failed: ${describeRequestError(res.error)}`})
    }
    const response = res.value
    if (!response.ok) {
      await response.close()
      return err({message: `download returned status ${response.status}`})
    }
    // A server free to ignore Range answers 200 with the whole build. Drop the
    // prefix we already hold rather than failing, which would spend a retry
    // for nothing.
    let skip = response.status === 206 ? 0 : from
    for await (const chunk of response.body) {
      if (!chunk.ok) {
        await response.close()
        return err({message: `reading the download failed: ${describeRequestError(chunk.error)}`})
      }
      let bytes = chunk.value
      if (skip > 0) {
        if (bytes.length <= skip) {
          skip -= bytes.length
          continue
        }
        bytes = bytes.subarray(skip)
        skip = 0
      }
      const written = update.write(bytes)
      if (!written.ok) {
        await response.close()
        return written
      }
    }
    return ok()
  }

  function check(options: CheckOptions = {}): Promise<CheckResult> {
    const enrolled = enrollment()
    if (enrolled === undefined) {
      return Promise.resolve({status: 'not-enrolled'})
    }
    return enqueue(() => runCheck(enrolled, options))
  }

  function watch(options: WatchOptions = {}): Watcher {
    const maybeEnrolled = enrollment()
    if (maybeEnrolled === undefined) {
      io.log('info', 'ota: device not enrolled; run `mikro ota enroll` to enable OTA updates')
      return {stop: () => undefined}
    }
    // Explicitly typed: the narrowing above does not reach into the hoisted
    // round() declaration below.
    const enrolled: Enrollment = maybeEnrolled
    const intervalMs = options.checkinIntervalMs ?? DEFAULT_INTERVAL_MS
    const retryMs = Math.min(options.retryAfterFailureMs ?? DEFAULT_RETRY_MS, intervalMs)

    let stopped = false
    let cancelSleep: (() => void) | undefined

    // ±10% so a power-cut fleet doesn't stay phase-locked on the registry.
    const jitterOn = options.jitter ?? true
    function jitter(ms: number): number {
      if (!jitterOn) return ms
      return Math.round(ms * (0.9 + io.random() * 0.2))
    }

    function pause(ms: number): Promise<void> {
      return new Promise((resolve) => {
        cancelSleep = resolve
        void io.sleep(jitter(ms)).then(resolve)
      })
    }

    async function round(): Promise<NextRound> {
      let teardown: Teardown | undefined
      if (options.beforeCheck) {
        let setup: Result<Teardown, unknown>
        try {
          setup = await options.beforeCheck()
        } catch (e) {
          setup = err(e)
        }
        if (!setup.ok) {
          io.log('warn', 'ota: beforeCheck failed; skipping this check', setup.error)
          return 'soon'
        }
        teardown = setup.value
      }

      // Contain OTA faults: an uncaught throw (e.g. an OOM from the native
      // HTTP layer under a low-heap stream) must not bubble out of the
      // detached loop. A crashed check is just a check that didn't complete.
      let outcome: CheckResult | undefined
      try {
        outcome = await enqueue(() => runCheck(enrolled, options))
      } catch (e) {
        io.log('error', 'ota: check crashed', e)
      }

      // Teardown before any restart: the round is over either way, and the
      // hook's invariant — teardown runs whenever setup succeeded — must not
      // depend on what the check found.
      if (teardown !== undefined) {
        try {
          await teardown()
        } catch (e) {
          io.log('warn', 'ota: teardown failed', e)
        }
      }

      if (outcome === undefined) return 'soon'
      if (outcome.status === 'staged') {
        if (stopped) {
          // stop() won the race: leave the build armed for the next natural
          // reboot instead of restarting under the caller.
          io.log('info', 'ota: update staged; watcher stopped, restart deferred')
          return 'later'
        }
        io.log('info', 'ota: staged; restarting to install')
        io.restart() // never returns
      }
      return outcome.status === 'failed' ? 'soon' : 'later'
    }

    async function loop(): Promise<void> {
      await pause(options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
      while (!stopped) {
        const next = await round()
        if (stopped) return
        await pause(next === 'later' ? intervalMs : retryMs)
      }
    }

    // Detached: never awaited by the caller, so the app keeps running
    // regardless of OTA outcome. round() contains every throw, so this
    // promise cannot reject.
    void loop()

    return {
      stop: () => {
        stopped = true
        cancelSleep?.()
      },
    }
  }

  return {check, watch}
}

/** Render a RequestError into prose. `DownloadFn`'s contract carries only a
 *  `message` string forward into the `DownloadFailed` the policy reports, so
 *  this line is all that survives to explain a failed download on serial —
 *  include the underlying message, not just the variant name. */
function describeRequestError(error: RequestError): string {
  return 'message' in error && error.message !== '' ? `${error.name}: ${error.message}` : error.name
}

/**
 * The name pair a check-in response carries, as `[rev, name]` (or `[rev]` when
 * it was cleared), or undefined when there is nothing to adopt. No `name` field
 * means "no change" and never "clear it": a response lost after the registry
 * adopted the device's own name looks exactly the same as one that never
 * arrived, and re-sending the pair next check-in settles it.
 */
export function nameFrom(body: unknown): DeviceName | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const pair = (body as {name?: unknown}).name
  if (!Array.isArray(pair)) return undefined
  const rev = pair[0]
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) return undefined
  const value = pair[1]
  return typeof value === 'string' && value !== '' ? {rev, name: value} : {rev}
}

/** True when both urls share a scheme and authority. Deliberately literal: with
 *  no URL parser here, a spelled-out default port does not compare equal. Used
 *  to decide whether the update key may ride the download request. */
export function sameOrigin(a: string, b: string): boolean {
  const origin = (url: string): string | undefined => {
    const sep = url.indexOf('://')
    if (sep < 0) return undefined
    const start = sep + 3
    const end = url.indexOf('/', start)
    const authority = end < 0 ? url.slice(start) : url.slice(start, end)
    return authority === '' ? undefined : (url.slice(0, start) + authority).toLowerCase()
  }
  const left = origin(a)
  return left !== undefined && left === origin(b)
}

/** True for http:// on a LAN/loopback/mDNS host: development, not the internet.
 *  Anywhere else the scheme is not a judgement call — over http the offer's
 *  checksum is forgeable in the same response that names it. */
export function isPrivateHttp(url: string): boolean {
  if (!url.startsWith('http://')) return false
  const host = (url.slice(7).split('/')[0] ?? '').split(':')[0] ?? ''
  if (host === 'localhost' || host.endsWith('.local')) return true
  const p = host.split('.').map((s) => parseInt(s, 10))
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (p[0] === 10 || p[0] === 127) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 169 && p[1] === 254) return true
  return p[0] === 172 && p[1]! >= 16 && p[1]! <= 31
}
