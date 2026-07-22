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

export interface Ota {
  /** Report what happened to a previous update on this boot, and clear the report. */
  reconcile(): InstallOutcome
  /** The build currently executing, read from the live app. */
  running(): RunningBuild
  /** Validate a registry value into an `Offer`, or `undefined` if unusable.
   *  `allowInsecure` (dev only) accepts an http build url instead of https. */
  parseOffer(raw: unknown, opts?: {allowInsecure?: boolean}): Offer | undefined
  /** Run the full update policy: skip checks, compatibility, retry limit,
   *  download via the `download` callback, and verification. */
  applyOffer(
    offer: Offer,
    download: DownloadFn,
    options?: InstallOptions,
  ): Promise<Result<ApplyOutcome, OtaError>>
  /** Mark the running trial as healthy so it is kept rather than rolled back. */
  confirm(): void
  /** Reinstall the previous build immediately. */
  revert(): Result<void, OtaInstallError>
  /** The check-in bearer: the device credential written at enrollment
   *  (`mikro ota enroll`), or `undefined` on an un-enrolled device. Read-only:
   *  credentials are provisioned over serial, never delivered in-band. */
  bearer(): string | undefined
  /** The registry url the device was enrolled against, written next to the
   *  credential at enrollment, or `undefined` on an un-enrolled device. */
  registry(): string | undefined
}

/** The `mikro/ota` singleton. The runtime value is provided by the on-device
 *  builtin (or the sim stub); this declaration carries its type for hosts. */
export declare const ota: Ota
