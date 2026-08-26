---
title: ota
description: Over-the-air app build updates with trial install and rollback
---

# ota

```ts
import {ota} from 'mikro/ota'
```

Install a new app build that your app has downloaded, run it on a trial, and roll back
automatically if it fails. The module does not download anything itself: your app fetches the
build bytes over its own connection and writes them in. `ota` is a named export, like every
other module in the API.

Most apps never call this module directly: the built-in
[`mikro/ota/client`](/api/ota-client) drives it, wire included. This page is the reference
for apps that bring their own transport. The
[Over-the-air Updates guide](/ota) walks through a full update cycle.

## Methods

### ota.reconcile()

```ts
reconcile(): InstallOutcome
```

Reports what happened to a previous update on this boot, and clears the report. Call it once
at startup. The actual install, trial check, and rollback run in the firmware before your app
loads; this returns their result so you can forward it to the registry.

One side effect: it hands the per-boot retry budget back, since a reboot is the only signal
available that a transient failure (out of memory, a truncated download) may have cleared. An
attempt that took the device down while it was running is the exception: that one keeps its
count, so a build that crash-loops the device still runs out of tries. Call it once, at
startup. Calling it inside a polling loop resets the budget every pass and defeats the retry
limit.

### ota.running()

```ts
running(): RunningBuild
```

Returns the build that is currently executing, read from the live app. During a trial it
reports the new build with `trial: true`; after a rollback it reports the previous one. A
build that was only downloaded is never reported here.

### ota.parseOffer(raw)

```ts
parseOffer(
  raw: unknown,
  opts?: {allowInsecure?: boolean},
): Offer | undefined
```

Validates a value received from a registry into an `Offer`, or returns `undefined` if it is
not a usable offer. Requires an `https` URL ending in `.tgz` and a non-empty checksum. Pass
`{allowInsecure: true}` (dev only) to also accept an `http` URL when testing against a local
registry.

`parseOffer` does not check the download URL's host. The offer arrives in an authenticated
check-in response from the enrolled registry, so the registry is trusted to name where the
build lives: its own host, a CDN or object store on another host, or a signed URL with the
signature in its query. Integrity comes from the checksum, verified over the whole download
before install, so a wrong or hostile host yields a failed install rather than a bad one. Send
the update key only to the registry's own origin (the reference client checks this before
attaching it), so a build fetched elsewhere goes out as an unauthenticated request for what is,
with the checksum, a public artifact.

```ts
const offer = ota.parseOffer(body)
```

### ota.applyOffer(offer, download, options?)

```ts
applyOffer(
  offer: Offer,
  download: (update: Update) => Promise<Result<void, {message: string}>>,
  options?: InstallOptions,
): Promise<Result<ApplyOutcome, OtaError>>
```

Runs the full update policy: the skip checks below, the retry limit, the `download` callback to
fetch the bytes, and verification against the checksum and size before staging. Compatibility
is not re-checked here. The registry picks a build that fits the firmware and bytecode version
the device reported, and the offer carries neither field.

Only `'staged'` means bytes landed; restart to apply it. The rest are the policy working as
intended, reported separately because your next move differs:

| Outcome           | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `'staged'`        | Downloaded, verified, armed for install. Restart to apply it. |
| `'trial-pending'` | A trial is unresolved. Confirm the running build first.       |
| `'current'`       | This build is already running.                                |
| `'abandoned'`     | Abandoned as corrupt; it will not be retried.                 |
| `'exhausted'`     | The retry budget for this build is spent until the next boot. |

`'trial-pending'` is the one that needs care. It means the device is still on trial for the
build it is running, and that build has to be settled before another can be taken. Confirm
the running build on its own merits (a completed check-in, your own health check) rather
than treating the new offer as the thing to handle. Confirming first also lets the offer be
taken on the same pass, since a resolved trial no longer blocks it. See
[the update guide](/ota) for the shape.

The `download` callback is your only transport code: fetch bytes any way you like and write them
with `update.write`, returning `ok()` when done or `err({message})` to signal a download
failure. `applyOffer` turns that into a retryable `DownloadFailed` error.

### ota.confirm()

```ts
confirm(): void
```

Marks the running trial as healthy, so it is kept rather than rolled back. Only meaningful for
a build installed with `requireConfirm`; otherwise a trial is kept automatically once it
survives a clean cycle. Does nothing when no trial is in progress.

One call settles both trials: the build's and a delivered config document's. A completed
check-in is the health signal each of them waits for. A config trial has one more gate: it
settles only once the app has read the document with `ota.config()`, because a check-in that
completes before the app ever ran with the new values proves nothing about them. So a
`confirm()` from an app that never reads its config keeps nothing, and the document is rolled
back when the trial boots run out.

### ota.revert()

```ts
revert(): Result<void, OtaInstallError>
```

Reinstalls the previous build immediately.

### ota.bearer()

```ts
bearer(): string | undefined
```

The device's check-in update key, written to the system store by
[`mikro ota enroll`](/cli#mikro-ota-enroll), or `undefined` on an un-enrolled device. Send it
as the `Authorization: Bearer` header on registry check-ins. Read-only: update keys are
provisioned over the cable and never delivered in-band, so a 401 response means re-enrolling
at a workstation, not clearing state.

### ota.registry()

```ts
registry(): string | undefined
```

The registry origin the device was enrolled against, written next to the update key by
[`mikro ota enroll`](/cli#mikro-ota-enroll), or `undefined` on an un-enrolled device. The
check-in url is `${ota.registry()}/api/v1/checkin`.

### ota.config()

```ts
config<T = RegisteredConfig>(): T // RegisteredConfig is your registered `OtaConfig`,
                                 // or `unknown` until you register one
```

The app's effective config, always an object. The device resolves it in one step: the defaults
materialized into the running build's manifest, with the document a registry delivered spread
over them at the top level. Nothing merges deeper, and the device validates nothing: the
registry that wrote the document validated it against the
[config schema](/api/schema#annotations) for this exact release, and it is the same party that
ships the code the device runs. Every call hands back a fresh object, so mutating what you read
never reaches the cached defaults.

Absence is per field, not for the config as a whole. A field the schema gives a default always
has a value; a field with no default is present only once an operator has supplied one.
`InferRead` is the type of exactly that shape, so register it once next to the schema
definition and every call is typed with no parameter:

```ts
// app/ota.config.ts
export const ConfigSchema = object({interval: number({default: 60}), endpoint: string()})

declare global {
  interface OtaConfig extends InferRead<typeof ConfigSchema> {}
}
```

```ts
import {ota} from 'mikro/ota'

const config = ota.config() // {interval: number; endpoint?: string}
```

Use `InferRead`, not `Infer`, in that registration. `Infer` is the write type, everything an
operator must supply for a document to validate; `InferRead` is what a read can hand back, with
the fields defaults cannot fill marked optional. See
[InferRead](/api/schema#inferread-the-read-type).

An explicit type parameter also works, wins over the registration, and suits a quick script:
`ota.config<Config>()`. (The registration is a global interface rather than a
`declare module 'mikro/ota'` augmentation because module augmentation does not merge through
re-exported types.)

Either way the type holds because every writer validated the document against the schema
serialized from the same definition the type derives from, in the same build. No schema and no
schema machinery is on the device: a read spreads a stored document over a small defaults object
parsed once out of the manifest.

`config()` throws in one case: a build that carries no readable manifest and holds no stored
document. That is a build that never went through the tooling, so there is nothing to serve and
nothing to branch on. Deploy it with `mikro deploy`, or run `mikro dev`.

Two things are held between calls. The manifest defaults are parsed once, on the first call that
needs them, and kept. The last document that read successfully is kept too, and served while,
and only while, the store cannot answer: a read allocates, so it can fail under heap pressure
with a TLS handshake in flight, and dropping a live app onto the defaults for a beat would
re-configure its hardware mid-handshake. A document that was genuinely cleared removes the key
and reads back as an honest absence, so a clear is never mistaken for a failed read.

Before any read has succeeded this runtime there is no last-good document to hold on to, and a
failing store then reads as the defaults. This is a deliberate choice: under a storage failure
the app runs on its defaults rather than idling. For an app where idling is the safer response,
check the values you care about yourself.

A stored document that will not decode, and one stamped for a version other than the one
running, are not store failures at all. Both read as the defaults, because a document the
device cannot use is no different from none stored. Neither is discarded: the device keeps
echoing the `rev` it holds, and the registry decides from that whether to send a document
again.

Every call reads current state. Stored config changes when a check-in completes, so a
wake-cycle app that runs `await check()` before its work reads fresh values at the end of the
cycle; the check result's `configUpdated` says whether a re-read is worth it.

What the registry serves is a deviation overlay: only the top-level values that differ from this
release's defaults, each one complete. The device resolves it with the single top-level spread
above, which is why a deviating value inside a nested object or a union ships whole rather than
in pieces. Delivery is otherwise unchanged: a document goes on trial, is rolled back on a
failure, and its `rev` is echoed on the next check-in.
[The registry spec](/registry-spec#config-sync) carries the normative rules.

The first read of each boot also accounts the config trial: a freshly delivered document that
is never followed by a completed check-in (say it names a GPIO this board does not have and
the app crashes on it) is rolled back by the read itself once the trial boots run out, the
previous document restored, and the failure reported to the registry as `configError` on the
next check-in. This lives in the read because a config-caused crash can fire before any
check-in runs, but never before the app reads the config that causes it. Only a read that
actually serves the stored document is charged: a boot that runs on the defaults never spends a
trial boot.

### ota.parseConfig(raw)

```ts
parseConfig(raw: unknown): StoredConfig | undefined
```

Validates a config document received from a registry, or returns `undefined` if it is not a
usable one. What [`parseOffer`](#ota-parseoffer-raw) is to an offer. Only a client that
brings its own transport needs it; the built-in client validates what it receives itself.

A usable document is an object with a non-empty `version` (the release the document was
computed for, which decides where `applyConfig` puts it), an optional `rev` short enough to
store intact, and a `doc` that is an object or absent. An absent `doc` is the clear, not a
malformed document.

Whether the document survives encoding is settled by `applyConfig`, which is where the stored
bytes are made. A value CBOR cannot carry, a function or a cycle, passes here and comes back
from `applyConfig` as `'invalid'`.

```ts
const config = ota.parseConfig(body.config)
```

### ota.applyConfig(config, options?)

```ts
applyConfig(
  config: StoredConfig,
  options?: {trialBoots?: number},
): ConfigWrite
```

Stores a config document. This is the write side of what [`ota.config()`](#ota-config) reads,
for a client that received a document over its own transport.

The `version` stamp decides where the document lands. Stamped for the running release, it is
applied: the document it replaces is kept as the rollback baseline, and a trial is armed.
Stamped for another release, it is staged for the build it names, and applies when that build
installs. The return value says which happened, and says when nothing did. See
[ConfigWrite](#configwrite).

```ts
const write = ota.applyConfig(config, {trialBoots: 4})
if (write === 'failed') {
  // Nothing was written. Keep echoing the rev from configState() so the
  // registry serves the document again on the next check-in.
}
```

A delivery to the running release goes on trial, the same as one from the built-in client.
Each boot whose first `ota.config()` read serves the document spends one of `trialBoots`
(default 1), and the budget spent with no `ota.confirm()` in between restores the previous
document and reports the failure to the registry as `configError`. On a device that wakes
from deep sleep, every wake is a boot, so raise `trialBoots` when a check-in can plausibly
fail for several cycles in a row. Otherwise one failed check-in rolls back a good document.

The app must read the document with `ota.config()` for `ota.confirm()` to keep it.

### ota.configState()

```ts
configState(): ConfigState
```

What the device owes its registry about config: the `rev` to echo, and a document that failed
its trial and was rolled back. A client that builds its own check-in body needs both. Without
the echo the registry serves the same document at every check-in. Without the report a
document that took the device down is served forever, and the operator is never told why.

```ts
const state = ota.configState()
await myRegistry.checkIn({
  running: ota.running(),
  configRev: state.rev,
  configError: state.error,
})
```

After a rolled-back trial, `rev` is the failed document's rev rather than the restored one's.
That is deliberate: the registry stops serving a document whose rev the device already echoes,
which is what keeps a bad document from being sent again until an operator changes it.

## Types

### Update

The staging session handed to your `download` callback. It is opened and closed by `applyOffer`; if a
partial download for the same checksum is already staged, `resumeOffset` is where it stopped.

```ts
interface Update {
  // Bytes already staged for this checksum. Start a Range request here to resume.
  readonly resumeOffset: number

  // Append downloaded bytes. Enforces the size limit as bytes arrive.
  write(bytes: Uint8Array): Result<void, OtaWriteError>

  // Verify the staged build against the checksum and size, then stage it for install.
  // Defaults to installing on the next boot; pass {install: 'now'} to install in place.
  finish(options?: InstallOptions): Result<void, OtaError>

  // Discard the staging session.
  abort(): void
}
```

The `download` callback only needs `resumeOffset` and `write`. `finish` and `abort` are called by
`applyOffer` around it.

### Offer

```ts
interface Offer {
  url: string // https URL of the .tgz build
  checksum: string // content hash, verified after download
  size: number // build size in bytes
}
```

### InstallOptions

```ts
interface InstallOptions {
  trialBoots?: number // clean cycles a trial must survive before it is kept (default 1)
  requireConfirm?: boolean // require ota.confirm() instead of auto-keeping (default false)
  install?: 'now' | 'next-boot' // when to unpack and swap (default 'next-boot')
}
```

### InstallOutcome

```ts
interface InstallOutcome {
  installed?: string // checksum of a build installed this boot, if any
  reverted: boolean // whether a trial was rolled back this boot
  lastInstall?: Diagnostic // why a previous install failed, to forward to the registry
}
```

### RunningBuild

```ts
interface RunningBuild {
  checksum?: string // checksum of the executing build
  version?: string // its package.json version
  trial: boolean // true while it is still on trial
}
```

### Diagnostic

```ts
interface Diagnostic {
  reason: string // short failure category, e.g. "ota_install_failed"
  detail?: string // human-readable detail
}
```

### StoredConfig

```ts
interface StoredConfig {
  rev?: string
  version: string
  doc?: unknown
}
```

One config document, as a registry computed it and the device stores it. `rev` is the opaque
token echoed on check-ins, `version` is the release the document was computed for, and `doc`
is the deviation overlay a read resolves over the build's manifest defaults. An absent `doc`
is the clear. The device stores and returns the document without understanding it: validation
belongs to the writer, which already holds the schema.

### ConfigWrite

```ts
type ConfigWrite = 'applied' | 'staged' | 'cleared' | 'unchanged' | 'failed' | 'invalid'
```

What [`applyConfig`](#ota-applyconfig-config-options) did to the store.

| Value         | Meaning                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `'applied'`   | Stored as the running build's config. A trial is armed.                                               |
| `'staged'`    | Stored for the release it names. It applies when that build installs.                                 |
| `'cleared'`   | The document was removed. The manifest defaults stand alone again.                                    |
| `'unchanged'` | Identical to the document already held, or a clear with nothing to clear.                             |
| `'failed'`    | Nothing was written: the store could not answer, or the running version could not be read. Transient. |
| `'invalid'`   | Not a usable config document.                                                                         |

Only `'applied'` and `'cleared'` change what the running build reads. On `'failed'`, keep
echoing the rev from `configState()`, so the registry serves the document again.

### ConfigState

```ts
interface ConfigState {
  rev?: string
  error?: {rev: string; message: string}
}
```

The two config fields a check-in body owes the registry, from
[`configState()`](#ota-configstate). Send them as `configRev` and `configError`.

## Errors

Each error is a typed [`Result`](/api/result) value with a `name` you can switch on.

Listed in the order an update passes through them.

| Error              | `name`                    | When                                                       |
| ------------------ | ------------------------- | ---------------------------------------------------------- |
| `OtaBeginError`    | `StagingFailed`           | Staging could not **start**: bad offer, or it will not fit |
| `OtaDownloadError` | `DownloadFailed`          | The `download` callback failed; retried on a later attempt |
| `OtaWriteError`    | `StagingFull`, `TooLarge` | Staging **ran out of room**, or exceeded the offered size  |
| `OtaInstallError`  | `InstallFailed`           | The staged build failed to unpack or swap                  |
| `OtaError`         | any of the above          | Returned by `applyOffer` and `finish`                      |

`OtaInstallError` carries a `kind` field: `corrupt` for a build whose bytes are bad (retrying
the same bytes cannot help, so it is abandoned), or `transient` and `oom` for storage and
memory failures that are retried within the retry limit.

`StagingFailed` is never abandoned. A malformed offer is not the build's fault, and the
abandoned list is permanent with nothing to clear it, so blacklisting here would mean a
corrected re-publish of the same build could never be taken.
