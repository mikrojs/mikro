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

The [Over-the-air Updates guide](/ota) walks through a full update cycle. This page is the
reference for each method and type.

## Methods

### ota.reconcile()

```ts
reconcile(): InstallOutcome
```

Reports what happened to a previous update on this boot, and clears the report. Call it once
at startup. The actual install, trial check, and rollback run in the firmware before your app
loads; this returns their result so you can forward it to the registry.

One side effect: it hands the per-boot retry budget back, since a reboot is the only signal
available that a transient failure (out of memory, a truncated download) may have cleared.
Call it once, at startup — calling it inside a polling loop resets the budget every pass and
defeats the retry limit.

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
build lives — its own host, a CDN or object store on another host, or a signed URL with the
signature in its query. Integrity comes from the checksum, verified over the whole download
before install, so a wrong or hostile host yields a failed install rather than a bad one. Send
the credential only to the registry's own origin (the reference client checks this before
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

Runs the full update policy: the skip checks below, compatibility, the retry limit, the `download` callback to
fetch the bytes, and verification against the checksum and size before staging.

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
the running build on its own merits — a completed check-in, your own health check — rather
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

### ota.revert()

```ts
revert(): Result<void, OtaInstallError>
```

Reinstalls the previous build immediately.

### ota.bearer()

```ts
bearer(): string | undefined
```

The device's check-in credential, written to the system store by
[`mikro ota enroll`](/cli#mikro-ota-enroll), or `undefined` on an un-enrolled device. Send it
as the `Authorization: Bearer` header on registry check-ins. Read-only: credentials are
provisioned over the cable and never delivered in-band, so a 401 response means re-enrolling
at a workstation, not clearing state.

### ota.registry()

```ts
registry(): string | undefined
```

The registry origin the device was enrolled against, written next to the credential by
[`mikro ota enroll`](/cli#mikro-ota-enroll), or `undefined` on an un-enrolled device. The
check-in url is `${ota.registry()}/api/v1/checkin`.

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
