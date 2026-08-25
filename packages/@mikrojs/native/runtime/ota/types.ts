import type {RequestError} from 'mikro/http/helpers'

import type {CborError} from '../cbor/types.js'
import type {Result} from '../result/types.js'

/** An update offered by a registry: what to fetch and how to verify it, nothing
 *  more. Whether this device should take it is the registry's decision, made
 *  against the firmware and bytecode version the device reports at check-in and
 *  the whole set of builds it holds. Validate untrusted input with `parseOffer`. */
export interface Offer {
  /** https URL of the .tgz build */
  url: string
  /** content hash, verified after download */
  checksum: string
  /** build size in bytes */
  size: number
}

export interface InstallOptions {
  /** clean cycles a trial must survive before it is kept (default 1) */
  trialBoots?: number
  /** require `ota.confirm()` instead of auto-keeping (default false) */
  requireConfirm?: boolean
  /** when to unpack and swap (default 'next-boot') */
  install?: 'now' | 'next-boot'
}

export interface Diagnostic {
  /** short failure category, e.g. "ota_install_failed" */
  reason: string
  /** human-readable detail */
  detail?: string
}

export interface InstallOutcome {
  /** checksum of a build installed this boot, if any */
  installed?: string
  /** whether a trial was rolled back this boot */
  reverted: boolean
  /** why a previous install failed, to forward to the registry */
  lastInstall?: Diagnostic
}

export interface RunningBuild {
  /** checksum of the executing build */
  checksum?: string
  /** its package.json version */
  version?: string
  /** true while it is still on trial */
  trial: boolean
}

export interface Update {
  /** Bytes already staged for this checksum. Start a Range request here to resume. */
  readonly resumeOffset: number

  /** Append downloaded bytes. Enforces the size limit as bytes arrive. */
  write(bytes: Uint8Array): Result<void, OtaWriteError>

  /** Verify the staged build against the checksum and size, then stage it for install.
   *  Defaults to installing on the next boot; pass `{install: 'now'}` to install in place. */
  finish(options?: InstallOptions): Result<void, OtaError>

  /** Discard the staging session. */
  abort(): void
}

/** The download callback given to `applyOffer`. Fetch the build bytes any way
 *  you like and write them with `update.write`; return `ok()` when done, or
 *  `err({message})` to signal a download failure (retried on a later attempt). */
export type DownloadFn = (update: Update) => Promise<Result<void, {message: string}>>

/** Staging ran out of room, or exceeded the offered size. */
export type OtaWriteError =
  | {name: 'StagingFull'; message: string}
  | {name: 'TooLarge'; message: string}

/** Staging could not be started: the offer is malformed, or the build does not
 *  fit this device's filesystem. Not blacklisted — a malformed offer is not the
 *  build's fault, and a re-publish at a corrected size must be able to succeed. */
export type OtaBeginError = {name: 'StagingFailed'; message: string}

/** The build failed to unpack or swap. `kind` is `corrupt` for bad bytes
 *  (retrying cannot help, so it is abandoned), or `transient`/`oom` for storage
 *  and memory failures that are retried within the retry limit. */
export type OtaInstallError = {
  name: 'InstallFailed'
  kind: 'corrupt' | 'transient' | 'oom'
  message: string
}

/** The download callback returned a failure. Transient: the attempt is
 *  retried on a later `applyOffer`, not abandoned (unlike a corrupt build). */
export type OtaDownloadError = {name: 'DownloadFailed'; message: string}

/** Why `applyOffer` did not stage the offer. Only `staged` means bytes landed.
 *
 *  These are outcomes, not errors: each one is the policy working as intended.
 *  They are distinguished because the caller's next move differs — in
 *  particular `trial-pending` is the one case where the app should confirm the
 *  build it is running rather than treat the offer as handled. */
export type ApplyOutcome =
  /** The build was downloaded, verified, and armed for install. */
  | 'staged'
  /** A trial is unresolved: this device must settle the build it is running
   *  before it can take another. */
  | 'trial-pending'
  /** This build is already the running build. */
  | 'current'
  /** This build was abandoned as corrupt and will not be retried. */
  | 'abandoned'
  /** The retry budget for this build is spent until the next boot. */
  | 'exhausted'

/** Returned by `applyOffer` and `finish`. A failed checksum arrives here as
 *  `InstallFailed` with `kind: 'corrupt'` — the native side has no separate
 *  mismatch code, since it cannot tell a bad hash from bad bytes. */
export type OtaError = OtaWriteError | OtaBeginError | OtaInstallError | OtaDownloadError

/** One stored config document: the complete effective config computed and
 *  validated by the registry (or by the CLI at cable-seed time), the opaque
 *  token that identifies it, and the release version it was computed for.
 *  The device stores and returns it without understanding it: validation is
 *  the writer's job, and the registry already ships the code. */
export interface StoredConfig {
  /** Opaque registry-issued token echoed as `configRev` on check-ins. The
   *  registry serves its document whenever the echo differs from its own
   *  current rev, so a document it does not recognize is replaced. */
  rev?: string
  /** The release version this document was computed for. A document stamped
   *  for another version is ignored by `ota.config()`. */
  version: string
  /** The served document: the deviation overlay the read resolves over the
   *  build's manifest defaults. */
  doc?: unknown
}

/** The three config slots, mirroring the build's install slots: `current` is
 *  what the running build reads, `next` is staged with an offered build,
 *  `prev` is the rollback baseline while a trial is unresolved. */
export type ConfigSlot = 'current' | 'next' | 'prev'

/** A running-release config delivery on trial. `left` is the boot budget
 *  (each boot that reads config burns one); `read` records that the app has
 *  read the document since delivery. A completed check-in adopts the trial
 *  only once that is true, or an app that reads config only at boot could
 *  have a never-executed document adopted under it. */
export interface ConfigTrial {
  left: number
  read: boolean
}

/** A config document rolled back after a failed trial; reported on check-ins
 *  while it stands. `rev` names the failed document, and the client keeps
 *  echoing it as `configRev`, which is what stops the registry re-serving
 *  the same document until an operator changes the config. */
export interface ConfigErrorReport {
  rev: string
  message: string
}

declare global {
  /**
   * Merge your app's config type into this interface (next to the schema
   * definition) to type `ota.config()` app-wide, with no type parameter at
   * the call sites:
   *
   * ```ts
   * declare global {
   *   interface OtaConfig extends InferRead<typeof ConfigSchema> {}
   * }
   * ```
   *
   * A global rather than a module augmentation because `mikro/ota` re-exports
   * its types, and module augmentation does not merge through re-exports. An
   * explicit `ota.config<T>()` still works and wins over the registration.
   */
  interface OtaConfig {}
}

export type RegisteredConfig = keyof OtaConfig extends never ? unknown : OtaConfig

export interface Ota {
  /** Report what happened to a previous update on this boot, and clear the report. */
  reconcile(): InstallOutcome
  /** The build currently executing, read from the live app. */
  running(): RunningBuild
  /** Validate a registry value into an `Offer`, or `undefined` if unusable.
   *  `allowInsecure` (dev only) accepts an http build url instead of https. */
  parseOffer(raw: unknown, opts?: {allowInsecure?: boolean}): Offer | undefined
  /** Run the full update policy: skip checks and the retry limit, download
   *  via the `download` callback, and verification. Compatibility is not
   *  re-checked: the registry selected this build for the reported firmware,
   *  and a mismatched archive fails its checksum or fails to load. */
  applyOffer(
    offer: Offer,
    download: DownloadFn,
    options?: InstallOptions,
  ): Promise<Result<ApplyOutcome, OtaError>>
  /** Mark the running trial as healthy so it is kept rather than rolled back. */
  confirm(): void
  /** Reinstall the previous build immediately. */
  revert(): Result<void, OtaInstallError>
  /** The check-in bearer: the device update key written at enrollment
   *  (`mikro ota enroll`), or `undefined` on an un-enrolled device. Read-only:
   *  update keys are provisioned over serial, never delivered in-band. */
  bearer(): string | undefined
  /** The registry url the device was enrolled against, written next to the
   *  update key at enrollment, or `undefined` on an un-enrolled device. */
  registry(): string | undefined
  /**
   * The app's effective config: the running build's manifest defaults with the
   * document the registry computed for this release spread over them, top level
   * only. Always an object for a build that went through the tooling, so no
   * `?? fallback` at the call sites; fields the schema gives no default are the
   * ones that can be absent, and the read type marks exactly those optional.
   *
   * Reads current state on every call: it changes exactly when a check-in
   * completes, and every call hands back a fresh object, so mutating one never
   * reaches the cached defaults. The one thing held between calls is the last
   * document that read successfully, which is served while, and only while, the
   * store cannot answer. A read fails under heap pressure, and flipping a
   * running app onto the defaults for a beat would re-configure its hardware
   * mid-handshake. A cleared document removes the key and reads back as an
   * honest absence, so a clear is never mistaken for a failure.
   *
   * The device never merges deeper than one level and never validates: every
   * writer of the document validated it against this release's schema before
   * writing, and the type comes from the same source definition
   * (`ota.config<Config>()` with the schema's `InferRead`).
   *
   * Throws when there is nothing to serve at all: a build carrying no readable
   * manifest and no stored document (deploy it with `mikro deploy`, or run
   * `mikro dev`), or a store that failed before any read succeeded this runtime
   * on a build whose manifest could not be parsed either. Both are transient or
   * fixable states, never a value the app has to branch on.
   */
  config<T = RegisteredConfig>(): T
}

/** The `mikro/ota` singleton. The runtime value is provided by the on-device
 *  builtin (or the sim stub); this declaration carries its type for hosts. */
export declare const ota: Ota

/* ── mikro/ota/client ──────────────────────────────────────────────────────
 * The check-in client's surface. The implementation is C
 * (src/mik_ota_client.cpp); these are the shapes it marshals across. */

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
   *  networks should raise this above the default 1. The same budget arms a
   *  delivered config document's trial. */
  trialBoots?: number
}

/** Runs after its round settles: after the check and any download, and before
 *  an auto-restart, so the network brought up in `beforeCheck` can go down.
 *
 *  Whatever it returns is ignored, so it can call something that reports a
 *  Result without having to unwrap or discard it. A promise is awaited before
 *  the round is considered over. */
export type Teardown = () => unknown

/** What a `beforeCheck` hands back:
 *
 *  - a **function**: the round runs, and that function runs after it
 *  - **nothing**: the round runs, with no teardown
 *  - an **`err`**: the round is skipped and retried at the failure interval,
 *    and no teardown runs, since unwinding a partial setup is the hook's own job
 *  - an **`ok`**: as its value, a teardown function or nothing
 *
 *  Throwing has the same effect as returning an `err`. The bare-function form
 *  is there because wrapping a teardown in `ok()` is ceremony on the path that
 *  always succeeds; the Result form is what lets a failing setup hand its own
 *  error straight back. */
export type BeforeCheckResult = Teardown | void | Result<Teardown | void, unknown>

export interface WatchOptions extends CheckOptions {
  /** Steady interval between rounds, end-of-round to start-of-next. Default
   *  30m, floored at 30s: each round's TLS session leaves heap and socket
   *  residue that needs time to drain on small-heap devices, and the value
   *  may arrive from remote config, and the floor is what bounds the damage a
   *  mistyped document can do. */
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
  /** Bring the network up for one round. State shared with the teardown stays
   *  in this one scope. See {@link BeforeCheckResult} for what to hand back. */
  beforeCheck?(): BeforeCheckResult | Promise<BeforeCheckResult>
  /** Called after a completed round changes the effective config the running
   *  build reads: delivered or cleared by that round, or applied by this boot's
   *  install or rollback. Receives the new effective config. A watch loop is
   *  otherwise silent, so without this an app has to poll `ota.config()` to
   *  notice.
   *
   *  Not called for a config staged alongside an offered build: that one
   *  applies at its trial boot, so the running app cannot read it yet. */
  onConfig?(config: RegisteredConfig): void
}

export interface Watcher {
  /** Prevent future rounds and cancel the pending sleep. An in-flight round
   *  completes, but a build it stages no longer auto-restarts: it stays armed
   *  for the next natural reboot. */
  stop(): void
  /** Change the cadence without restarting the watcher, floored at 30s like
   *  {@link WatchOptions.checkinIntervalMs}. A wait already counting is re-timed
   *  from when it started, so a shorter interval brings the next round forward
   *  rather than waiting out the old one. The initial delay is left alone. */
  setCheckinInterval(intervalMs: number): void
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
export type CheckError =
  | RequestError
  | CborError
  | {name: 'Status'; status: number}
  /** The response body was past the size the client will buffer. */
  | {name: 'TooLarge'; message: string}

export type CheckResult =
  /** Build downloaded, verified, and armed. The app restarts when ready. */
  | {status: 'staged'; offer: Offer}
  /** `configUpdated` reports that the running build's stored config changed
   *  since the app could last have read it: delivered or cleared this round,
   *  or applied by this boot's install or rollback. An app that read config
   *  early in the cycle knows to read it again. */
  | {status: 'up-to-date'; configUpdated?: boolean}
  /** An offer arrived but was not armed. */
  | {status: 'not-staged'; reason: DeclineReason; error?: OtaError}
  /** Transient: the check-in did not complete, so the running trial (if any)
   *  was not confirmed. */
  | {status: 'failed'; error: CheckError}
  /** The registry rejected the update key (HTTP 401). Permanent until
   *  re-enrollment over the cable. */
  | {status: 'unauthorized'}
  | {status: 'not-enrolled'}
