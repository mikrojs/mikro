---
title: Over-the-air Updates
description: Update a device's app build remotely, over any transport, with automatic rollback
---

# Over-the-air Updates

The `mikro/ota` module installs a new app build that the application has downloaded, runs it
under a trial, and reverts to the previous build if it fails. It updates the **app build**
(the compiled JavaScript). The firmware binary itself is not updated over the air; it is
flashed over a cable.

The module performs no network I/O. The application fetches the build bytes over a transport
it chooses (cellular, WiFi, Bluetooth, a UART link, an SD card) and writes them in. The module
covers verification, installation, the trial, rollback, and retry limits.

## How an update works

1. The application asks a registry whether a newer build is available, over its own connection.
   The registry is a service the application talks to; it is not part of the module.
2. If a build is offered, the application streams the bytes into `mikro/ota`, which verifies
   them against the offered checksum and size and stages the build.
3. The application restarts. On the next boot the firmware installs the staged build and runs
   it as a trial.

## The trial model

An installed build boots as a trial rather than becoming permanent immediately. On the next
boot the firmware examines how the previous cycle ended and decides whether to keep or revert
it. In the common case this needs no application code:

- **Clean cycle** (a normal restart, a deep sleep wake, or an external reset): the build
  survived, so it is kept. It becomes the running version and the next rollback target.
- **Crash** (a panic or watchdog reset): the build is rolled back to the previous one
  immediately, without waiting for the trial to end.
- **Fatal JS error** (an uncaught exception or unhandled rejection at startup): a JS-level crash
  reboots as a clean reset rather than a panic, so the firmware records it while the build runs
  and rolls back on the next boot. A build that throws on startup is reverted, not kept.
- **Brownout or power-on**: ambiguous, since it may be a power problem rather than a fault in
  the app, so the trial continues without keeping or reverting.

The trial lasts one boot by default, so the build must survive its first run. On a device
that sleeps and wakes on a schedule, that means surviving one wake cycle.

### Confirming health yourself

Surviving a boot means the build neither crashed the device nor threw at startup. That doesn't
prove it actually works — it may have started, failed to reach the network or a sensor, and sat
there idle. For a stronger check, install the build with `requireConfirm`: the trial is then kept
only if `ota.confirm()` is called before the trial window ends, and reverts otherwise. Call it
after something the build can only pass when healthy, such as a successful registry check-in.

A natural place to call it is after a successful registry check-in: a completed check-in shows
the network stack and the application's main path are working, a stronger signal than surviving
a boot, and it reuses a request the application already makes:

```ts
import {ota} from 'mikro/ota'

const result = await myRegistry.checkIn({running: ota.running()})
if (result.ok) {
  // Only now: the check-in completed, so the running build is healthy.
  ota.confirm()
}
```

Confirm only when the check-in actually completed. A failed request is not a signal of health,
and it is the signal `requireConfirm` is watching for: a build whose own defect breaks
networking will fail every check-in, so confirming regardless would keep exactly the build that
should have been rolled back. Leave the trial unresolved instead and let it lapse.

`ota.confirm()` does nothing when there is no trial in progress, so it needs no guard for that
case — but it does need the one above.

Confirming at check-in proves the build boots and reaches the network. It does not prove the
rest of the app works, and confirming ends the trial: a build that checks in and then **hangs**
(an await that never settles, a wedged state machine) has already been confirmed, so it is not
rolled back — a hang is not a crash, so nothing reboots and the firmware's automatic revert
never fires. If your app can wedge in a way a reboot would not clear, confirm later — past a
point that only a working build reaches (a completed sensor read, a first job) — or drive a
hardware watchdog the app must keep feeding. Check-in is the right place to confirm only when a
stuck app always ends in a reboot.

To reverse an update on your own terms, call `ota.revert()`. It reinstalls the previous
build immediately.

## Compatibility

Two conditions decide whether a build can run on a device:

- **Bytecode version must match.** App builds are compiled to bytecode, which is tied to the
  exact engine build, so a build compiled for a different version will not load.
- **Firmware version must satisfy the build's caret range.** A build records the firmware it
  was compiled against as `firmwareVersion`, and serves every later firmware within the same
  breaking boundary — the major for `1.x`, the minor while the firmware is still `0.x` (semver
  treats a `0.x` minor bump as breaking). So a patch upgrade never needs a republish; a bump
  across the breaking boundary does, because that is where APIs disappear.

**The registry decides this, not the device.** A check-in reports the device's firmware and
bytecode version, and the registry picks a build that fits — or offers nothing. That is the
only place the decision can be made well: a device can refuse the build it was handed, but
it cannot ask for the right one instead, because it does not hold the other builds. So the
offer carries neither field and `applyOffer` stages what it is given.

Nothing is lost if a registry gets it wrong. A build that cannot run fails to load, the
trial reverts it, and the next check-in reports the failure so the registry stops offering
it — the same path as any build that fails on a device, and one an operator can see.

A device's own versions are on `mikro/sys` as `version` and `firmware.bytecodeVersion`.

## Writing the app side

The application provides two things: a registry to query for updates, and a way to move bytes.
A typical update cycle:

```ts
import {ota} from 'mikro/ota'
import {ok} from 'mikro/result'
import {restart} from 'mikro/sys'

// On boot, find out what happened to any previous update and report it.
const outcome = ota.reconcile()
// outcome: { installed?: string; reverted: boolean; lastInstall?: { reason, detail? } }

const checkin = await myRegistry.checkIn({
  running: ota.running(), // { checksum, version, trial } of what is executing now
  lastInstall: outcome.lastInstall, // forward a failure so the registry learns of it
})
// A check-in that never completed is not proof of health, so nothing below runs
// on it: no confirm (the trial must lapse and revert), no offer to act on.
if (!checkin.ok) return
const body = checkin.value

// Confirm before staging, and independently of whether an offer arrived. A
// completed check-in is proof this build's network path works, which is what
// requireConfirm waits for — whether or not the registry also had something
// newer. Gating the confirm on "no offer arrived" lets a healthy build lapse and
// roll back just because a newer one was published during its trial window.
// Confirming first also lets the offer below be taken on this same pass.
ota.confirm()

// Validate whatever the registry returned before acting on it. The offer fields
// are top-level in the check-in response, so the whole body goes to parseOffer,
// which enforces the scheme, the .tgz, the checksum and size. It does not check
// the download host: the registry names where the build lives, the checksum
// vouches for the bytes, and the credential (below) goes only to the registry.
const offer = ota.parseOffer(body)

// If an update is offered, apply it. The callback is your only transport code.
if (offer) {
  const result = await ota.applyOffer(
    offer,
    async (update) => {
      for await (const chunk of myRegistry.fetch(offer.url, {rangeFrom: update.resumeOffset})) {
        // Returning err() signals a failed download; applyOffer reports it as a
        // retryable `DownloadFailed` result rather than a corrupt build. Propagate
        // the real error (or compose one with `new Error(msg, {cause})`), not just
        // its name, so the cause survives.
        const written = update.write(chunk)
        if (!written.ok) return written
      }
      return ok()
    },
    // Keep the new build only once it calls ota.confirm() (after a successful
    // check-in); a build that crashes at startup never does, so the trial
    // reverts it instead of auto-keeping it.
    {requireConfirm: true},
  )

  if (result.ok && result.value === 'staged') {
    restart() // the firmware installs the staged build on the next boot
  }
}

// Run your normal cycle.
```

`applyOffer` runs the update policy: skipping a build that is already running or known bad,
retry limits, the download callback, and verification against the checksum and size.
Compatibility is the registry's decision (see above), not rechecked here. Only `'staged'` means bytes landed, which the application applies by
restarting. The other outcomes (`'trial-pending'`, `'current'`, `'abandoned'`, `'exhausted'`)
say why nothing was staged; see [the API reference](/api/ota#ota-applyoffer-offer-download-options).

`'trial-pending'` deserves attention: it means this device is still on trial for the build it
is running, and that build must be settled before another can be taken. Confirm on the
running build's own merits, as above, rather than treating the new offer as the thing to
handle.

`ota.running()` reports the build that is currently executing, read from the live app. During
a trial it reports the new build with `trial: true`; after a revert it reports the previous
one. A build that was only downloaded is never reported as running, so the registry can use
`running()` as an accurate record of what each device is on.

### Resuming an interrupted download

If a download is cut off, the bytes already received are kept. On the next attempt
`update.resumeOffset` holds the number of staged bytes, so your transport can request the
rest with an HTTP `Range` header instead of starting over. The final check hashes the whole
staged file, so resuming stays safe.

### Scheduling

The module has no timer. When to check in and how to run the download are left to the
application, which is what knows its constraints, such as a connectivity or maintenance
window, the cost of the connection, or a limited power budget.

## Relation to `mikro dev` and `mikro deploy`

OTA installs the same app build as `mikro dev` and `mikro deploy`, through the same engine.
The three differ only in how the bytes arrive.

| Command        | When                | How it sends            | Rollback target |
| -------------- | ------------------- | ----------------------- | --------------- |
| `mikro dev`    | development         | incrementally, per file | not affected    |
| `mikro deploy` | release, over cable | the whole build         | sets it         |
| OTA            | remote              | the whole build, by you | reverts to it   |

Deploying over a cable with `mikro deploy` leaves a known-good build on the device, which is
what gives the first OTA something to revert to. `mikro dev` stays incremental for a fast edit
loop and does not change the rollback target.

## The registry

A registry stores builds and decides which one each device should run. You run your own,
implementing the OTA registry protocol on a backend you operate. The
[`@mikrojs/registry`](https://github.com/mikrojs/mikro/tree/main/packages/@mikrojs/registry)
package is a ready-made reference implementation (a portable fetch handler with pluggable
storage and auth), and the
[ota example](https://github.com/mikrojs/mikro/tree/main/examples/ota) bundles it as a
one-file server (`registry/server.ts`); the [OTA Registry Spec](/registry-spec) is the
contract for building your own from scratch.

On your workstation, point the CLI at your registry once:

```sh
mikro ota setup
```

It prompts for the registry url and writes url + token to `.mikro/registry.json`
(project-level, gitignored with the rest of `.mikro`; `--user` writes
`~/.mikro/registry.json` instead, set once per machine). For the token, registries that
support browser login (the reference implementation does) show an approval url instead of
asking you to paste anything: approve in the browser and the registry mints a token scoped
to your app, which the CLI saves. Otherwise setup falls back to a hidden token prompt. The
file is plain `{"url": …, "token": …}` if you'd rather write it yourself, and
`--registry`/`--token` flags override it.

`mikro ota push` and `mikro ota enroll` read it, so neither needs flags once it is set.
The device learns the registry url at enrollment (below), never from env or a deploy.

## Enrolling devices

A registry answers only authenticated check-ins, and every device authenticates with its
own credential, minted by the registry when you enroll the device from your workstation:

```sh
mikro ota enroll
```

The CLI reads the hardware id off the connected device, registers it with the registry, and
writes the registry url and the returned credential to the device over the cable, as a pair.
Credentials never travel over the network to the device: the registry returns the credential
exactly once, in its response to the enrollment request. On the device the pair lives in the system store (`mik.sys`), which
deploys and `nvsStorage.clear()` never touch; the app reads it with
[`ota.registry()`](/api/ota#ota-registry) and [`ota.bearer()`](/api/ota#ota-bearer). Enrolling
also binds the device to the project's app, which is the only app it will ever be offered
builds for.

If a device's credential stops working (a 401 on check-in: it was re-minted, or the device
was deleted), re-enroll at the workstation with `mikro ota enroll --re-enroll`, which mints
a fresh credential and invalidates the old one immediately. The device treats only a 401
this way; transient errors keep the normal check-in cadence. For registries that mint
credentials through their own tooling instead of the enroll endpoint, write the secret
directly with `mikro ota enroll --credential <secret>`.

## Building and publishing builds

```sh
# Create a build from the current project.
mikro ota pack

# Build, pack, and upload it to your registry.
mikro ota push

# Upload and release it to the main channel in one step.
mikro ota push --release main
```

`mikro ota pack` builds your app to bytecode and packs it into a `.tgz` with a small manifest
recording the firmware version and bytecode version it targets. You can use it on its own for
a build artifact or a manual upload. `mikro ota push` uploads the build to the registry
configured by `mikro ota setup` (`.mikro/registry.json`), authenticated with the token stored
there. Pass `--registry` and `--token` to override them for a one-off.

## Release channels {#release-channels}

A channel is a movable pointer to a build, like a Docker tag or an npm dist-tag. A device is
enrolled on one channel and is offered whatever build that channel currently points at. The
device never knows which channel it is on; the mapping lives in the registry.

Uploading a build and serving it are two steps. `mikro ota push` uploads a build but serves
it to no one until a channel points at it. `mikro ota release <version> <channel>` moves a
channel to an already-uploaded build, and `mikro ota push --release <channel>` does both at
once.

The default channel is `main`. A typical flow: enroll test devices on a `beta` channel with
`mikro ota enroll --channel beta`, serve them with `mikro ota push --release beta`, and once a
build is proven, graduate that exact build to everyone with `mikro ota release <version> main`.
Rolling a channel back to an earlier build is the same command pointed at an older version.

## Limitations

- OTA replaces your app build, not the firmware binary.
- The new build, the previous one kept for rollback, and the unpacked app all share the
  device's storage. On a board with the default 1 MB app filesystem this puts a practical
  ceiling on app size for OTA; a larger app wants a larger filesystem partition, and
  `mikro ota pack` reports when a build is too large to install safely.
- A device whose app was only ever pushed with `mikro dev`, never `mikro deploy`, has no
  rollback target for its first OTA. If that first update fails, the device falls back to its
  recovery REPL, from which you re-deploy over a cable. Running `mikro deploy` once avoids
  this.
