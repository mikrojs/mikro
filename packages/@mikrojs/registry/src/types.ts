/** A stored build variant: one release's artifact for one bytecode version. */
export interface BuildRecord {
  /** SHA-256 of the `.tgz`, lowercase hex. Content address of the blob. */
  checksum: string
  app: string
  version: string
  bytecodeVersion: number
  /** Firmware version this build was compiled against. Not a floor: the
   *  registry offers it to devices at or above it within the same major. */
  firmwareVersion: string
  size: number
  note?: string
  /** ISO timestamp of the first publish of this build. */
  createdAt: string
  /**
   * ISO timestamp of the most recent publish of this build, including a
   * re-publish of bytes already stored. The highest one per
   * `(app, bytecodeVersion)` is the current build, which is what makes
   * re-publishing an earlier release a rollback. Absent on records written
   * before this field existed, which read as `createdAt`.
   */
  promotedAt?: string
}

/**
 * A channel pointer: which build one named channel currently serves for one
 * bytecode version of one app. Movable, unlike a build record, so a build
 * proven on `beta` can be pointed to by `stable` without re-publishing.
 *
 * The default channel `main` is NOT stored here: its current build is the
 * highest-`promotedAt` build (see `BuildRecord.promotedAt`), the pre-channels
 * mechanism, so existing builds keep serving with no migration. Only named
 * channels use this record.
 */
export interface ChannelRecord {
  app: string
  /** Channel name (never `main`, which is the promotedAt default). */
  channel: string
  bytecodeVersion: number
  /** Checksum of the build this channel serves for this app + bytecode. The key
   *  is unique, so there is exactly one record per channel and no ordering to
   *  keep: a release overwrites it. */
  checksum: string
}

export interface DeviceRecord {
  deviceId: string
  /** SHA-256 (lowercase hex) of the device credential; the plaintext is never stored. */
  credentialHash: string
  /** The only app this device may be offered builds for. Bound at enrollment
   *  and never inferred from what the device reports. Unset withholds every
   *  offer until the device is re-enrolled with one. */
  app?: string
  /** Release channel this device follows. Set at enrollment, registry-side; the
   *  device never knows it. Absent reads as `main`, so every device enrolled
   *  before channels keeps its behavior with no migration. */
  channel?: string
  name?: string
  /** Logical revision of `name`, bumped by every deliberate rename on either
   *  side, so renames can be ordered without a clock the device may not have.
   *  Absent on records predating name sync and read as 0. */
  nameRev?: number
  /** The name a device reported that lost a same-revision tie to the registry's
   *  (name sync rule 4). Kept so a concurrent rename is diagnosable: whoever
   *  renamed over the cable otherwise just sees their name flip back. */
  discardedName?: string
  lastSeen?: string
  runningChecksum?: string
  runningVersion?: string
  trial?: boolean
  lastFirmware?: string
  lastBytecode?: number
  /** Bytes free to download and stage one build, as last reported. A device
   *  that has never reported it is not size-gated at all, and a check-in that
   *  omits it leaves this standing rather than clearing it. */
  lastFree?: number
  /** Last install failure the device reported, validated to this shape before
   *  it is stored (it is device-supplied and is shown to operators). */
  lastInstall?: {reason: string; detail?: string}
  /** The checksum most recently offered to this device. */
  lastOfferedChecksum?: string
  /** Checksums this device reported failing; never re-offered. Bounded, newest
   *  kept, and cleared by `DELETE /devices/:deviceId/failures`. */
  failedChecksums: string[]
}

/** A token minted through browser login. One token covers publish and device
 *  enrollment; `app` limits both to that app. */
export interface TokenRecord {
  /** SHA-256 (lowercase hex) of the token; the plaintext is never stored. */
  tokenHash: string
  /** App this token may publish and enroll devices for. Unset: any app. */
  app?: string
  createdAt: string
  /** ISO timestamp after which the token is refused. A record without a
   *  parseable one is treated as expired. */
  expiresAt: string
  /** ISO timestamp of the last accepted request, to a minute's granularity so
   *  a busy token is not one storage write per request. */
  lastUsedAt?: string
}

/**
 * Storage backend. The defaults (`memoryStorage`, `fileStorage` from
 * `@mikrojs/registry/node`) are enough for a small fleet; implement this
 * interface to back the registry with whatever your server already uses.
 */
export interface RegistryStorage {
  putBlob(checksum: string, data: Uint8Array): Promise<void>
  getBlob(checksum: string): Promise<Uint8Array | undefined>
  getBuild(checksum: string): Promise<BuildRecord | undefined>
  putBuild(record: BuildRecord): Promise<void>
  listBuilds(): Promise<BuildRecord[]>
  /** Channel pointers for named channels (`main` is derived from `promotedAt`). */
  getChannel(
    app: string,
    channel: string,
    bytecodeVersion: number,
  ): Promise<ChannelRecord | undefined>
  putChannel(record: ChannelRecord): Promise<void>
  getDevice(deviceId: string): Promise<DeviceRecord | undefined>
  getDeviceByCredentialHash(hash: string): Promise<DeviceRecord | undefined>
  putDevice(record: DeviceRecord): Promise<void>
  listDevices(): Promise<DeviceRecord[]>
  getTokenByHash(hash: string): Promise<TokenRecord | undefined>
  putToken(record: TokenRecord): Promise<void>
  deleteToken(hash: string): Promise<void>
  listTokens(): Promise<TokenRecord[]>
}

export interface RegistryOptions {
  storage: RegistryStorage
  /**
   * Admin token accepted (verbatim, as an opaque bearer) on publish,
   * enroll, re-mint, and device listing. Provide this or `verifyAdmin`.
   * With `token` auth, the registry also serves the optional browser-login
   * flow (docs/registry-spec.md §5): approving with this secret at `/login`
   * mints a `tok_...` scoped to the requesting project's app.
   */
  token?: string
  /** Custom admin auth, replacing the static `token` comparison and
   *  disabling the built-in browser-login flow (wire your own). */
  verifyAdmin?(request: Request): boolean | Promise<boolean>
  /**
   * Custom device auth for check-ins: resolve a request to a deviceId, or
   * `undefined` for a 401. Default: bearer credential hashed and looked up
   * via `storage.getDeviceByCredentialHash`.
   */
  verifyDevice?(request: Request): string | undefined | Promise<string | undefined>
  /**
   * Public origin used in offer download urls (e.g. behind a proxy).
   * Default: the origin of the check-in request.
   */
  baseUrl?: string
  /**
   * Build identifier reported in the identity document at `GET /` (e.g. the
   * deployment's commit sha). Informational only: clients recognize a registry
   * by the document's `name`, never this. Omitted from the document when unset.
   */
  version?: string
}

export interface Registry {
  /** WinterTC fetch handler. Pass every request under the registry origin. */
  fetch(request: Request): Promise<Response>
}
