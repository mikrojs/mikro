---
title: Over-the-air Updates
description: Update a device's app build remotely, over any transport, with automatic rollback
---

# Over-the-air Updates

OTA updates the **app build** (the compiled JavaScript) on a device remotely. The device
installs the new build as a trial and rolls back automatically if the trial fails. OTA does
not update the firmware binary. To update the firmware, flash the device over a cable.

Two modules divide the work:

- [`mikro/ota/client`](/api/ota-client) is the built-in update client. It checks in with the
  registry over HTTPS, so it requires the network stack of the device. It downloads and
  stages an offered build, restarts to install it, and confirms the trial. For most apps,
  this client is enough: they make one call and write no other update code.
- [`mikro/ota`](/api/ota) provides the building blocks for the client. It verifies a downloaded build,
  installs it, runs the trial, rolls back, and enforces the retry limits. It performs no
  network I/O. An app with a custom transport (cellular, Bluetooth, a UART link, an SD
  card) can call it directly.

## The built-in client

Each kind of app needs one call:

```ts twoslash
import * as otaClient from 'mikro/ota/client'
import {restart} from 'mikro/sys'

// Always-on app: check in the background, restart when a build is staged.
otaClient.watch({checkinIntervalMs: 30 * 60_000}).orPanic('device not enrolled')

// Wake-cycle app: one check per wake; the app restarts on 'staged'.
const checked = await otaClient.check({trialBoots: 3})
if (checked.status === 'staged') restart()
```

The client does not connect the network. Start the network before a check, or per round with
the `beforeCheck` hook of watch mode. An un-enrolled device gets an explicit answer instead
of updates: `watch()` returns an `err` and starts no loop, and `check()` resolves to
`{status: 'not-enrolled'}`. Enrollment (below) is the opt-in. The [`ota/client` reference](/api/ota-client) covers the
options, the result type, and the
[`trialBoots`](/api/ota-client#trialboots-on-a-wake-cycle) setting for wake-cycle apps.

The [ota example](https://github.com/mikrojs/mikro/tree/main/examples/ota) shows the complete
always-on flow, registry included. The
[ota-wake-cycle example](https://github.com/mikrojs/mikro/tree/main/examples/ota-wake-cycle)
shows the deep-sleep variant.

## How an update works

1. The device asks a registry whether a newer build is available. The registry is a service
   that the device contacts. It is not part of the runtime.
2. If the registry offers a build, the app streams the bytes into `mikro/ota`. The module
   verifies the bytes against the offered checksum and size. Then it stages the build.
3. The device restarts. On the next boot, the firmware installs the staged build and runs
   it as a trial.

## The trial model

An installed build boots as a trial. It does not become permanent immediately. On the next
boot, the firmware examines how the previous cycle ended. Then it keeps or reverts the
build. In the common case this needs no application code:

- **Clean cycle** (a normal restart, a deep sleep wake, a power-on, or an external reset): the
  build survived, so the firmware keeps it. The build becomes the running version and the next
  rollback target.
- **Crash** (a panic or watchdog reset): the firmware rolls back to the previous build
  immediately. It does not wait for the trial to end.
- **Fatal JS error** (an uncaught exception or unhandled rejection at startup): a JS-level
  crash reboots as a clean reset, not as a panic. The firmware records the crash while the
  build runs, and rolls back on the next boot.
- **Brownout**: ambiguous, because the cause can be the supply and not the app. A bounded
  number of brownout boots are absorbed without counting against the trial, and the trial
  continues.

The trial lasts one boot by default, so the build must survive its first run. On a device
that sleeps on a schedule, that means one wake cycle.

### Confirm health yourself

A build that survives a boot did not crash the device and did not throw at startup. That
does not prove that the build works. It can start, fail to reach the network or a sensor,
and then sit idle.

For a stronger test, install the build with `requireConfirm`. The firmware then keeps the
trial only if the app calls `ota.confirm()` before the trial window ends. If the app does
not call it, the firmware reverts the build. Call `ota.confirm()` after an action that only
a healthy build can complete, for example a registry check-in.

The built-in client installs with `requireConfirm` and confirms on the next completed
check-in, unconditionally. If your app must confirm later than check-in, drive `mikro/ota`
yourself (see [Write your own client](#writing-your-own-client)). The confirm point is the
one part of the client that you cannot configure.

Call `ota.confirm()` after a completed registry check-in. A completed check-in shows that
the network stack and the main path of the application work. That signal is stronger than a
survived boot, and the check-in is a request that the application already makes:

```ts twoslash
declare const myRegistry: {checkIn(body: {running: unknown}): Promise<{ok: boolean}>}
// ---cut---
import {ota} from 'mikro/ota'

const result = await myRegistry.checkIn({running: ota.running()})
if (result.ok) {
  // Only now: the check-in completed, so the running build is healthy.
  ota.confirm()
}
```

Confirm only when the check-in completed. A failed request is not a signal of health. It is
the signal that `requireConfirm` watches for. A build whose own defect breaks the network
stack fails every check-in. A confirm on failure keeps exactly the build that rollback
exists to remove. Leave the trial unresolved and let it lapse.

`ota.confirm()` does nothing when no trial is in progress, so that case needs no guard. The
case above does.

A confirm at check-in proves that the build boots and reaches the network. It does not
prove that the rest of the app works, and the confirm ends the trial. A build can check in
and then **hang** (an await that never settles, a stuck state machine). The confirm already
ended its trial, so nothing reverts the build. A hang is not a crash. Nothing reboots, and
the automatic revert never fires.

Some apps can stop in a state that a reboot does not clear. For those apps, confirm later,
past a point that only a healthy build reaches (a completed sensor read, a first job). Or
drive a hardware watchdog that the app must feed. Confirm at check-in only when a stuck app
always ends in a reboot.

To reverse an update manually, call `ota.revert()`. It reinstalls the previous build
immediately.

## Compatibility

Two conditions decide whether a build can run on a device:

- **The firmware version must satisfy the caret range of the build.** A build records the
  firmware that it was compiled against as `firmwareVersion`. The build serves every later
  firmware within the same breaking boundary. That boundary is the major for `1.x`, and the
  minor while the firmware is `0.x` (semver treats a `0.x` minor bump as breaking). A patch
  upgrade never needs a republish, but a bump across the breaking boundary does, because
  that is where APIs disappear. A release stores one build per breaking range, and the
  registry serves the variant that matches the firmware of the device.
- **The bytecode version must match.** App builds compile to bytecode, and bytecode is tied
  to the exact engine build. A build compiled for a different version does not load. The
  registry also checks this, but the check follows from the firmware range: one toolchain
  produces one firmware/bytecode pair. It is a cross-check on the reported firmware, not
  the storage key for variants.

**The registry decides this, not the device.** A check-in reports the firmware and bytecode
version of the device. The registry picks a build that fits, or offers nothing. Only the
registry can make that decision well. A device can refuse the build that it received, but
it cannot ask for the correct one, because it does not hold the other builds. So the offer
carries neither field, and `applyOffer` stages what it receives.

A wrong choice by the registry causes no damage. A build that cannot run fails to load. The
trial reverts it, and the next check-in reports the failure, so the registry does not offer
that build again. This is the same path as any build that fails on a device, and an
operator can see it.

A device reports its own versions on `mikro/sys` as `version` and
`firmware.bytecodeVersion`.

## Write your own client {#writing-your-own-client}

Write your own client when the built-in client does not fit:

- Your devices use a different transport than HTTPS.
- A fleet backend that you already operate manages updates.
- Your server pushes updates, so the device does not poll.

Your client then does two things: it asks a server whether an update exists, and it moves
the bytes of the build to the device. The code below shows one complete update cycle:

```ts twoslash
import type {CheckinReport} from 'mikro/ota'
import type {Result} from 'mikro/result'
declare const myRegistry: {
  /** Your check-in call: POST the report, return the decoded response body.
   *  The body stays `unknown` on purpose: it is untrusted wire data, and
   *  ota.settle below is what validates it. */
  checkIn(body: CheckinReport): Promise<Result<unknown, {name: string; message: string}>>
  fetch(url: string, options: {rangeFrom: number}): AsyncIterable<Uint8Array>
}
// ---cut---
import {ota} from 'mikro/ota'
import {ok} from 'mikro/result'
import {restart} from 'mikro/sys'

// On boot, settle what happened to any previous update. This is also what
// surfaces the lastInstall report the check-in body carries.
ota.reconcile()

// report() assembles everything the device owes the registry: identity, the
// running build, the device name pair, free storage, a pending lastInstall
// report, and the config echo. Field shapes match the wire, so a server can
// forward them verbatim.
const checkin = await myRegistry.checkIn(ota.report())

// A check-in that never completed is not proof of health: no settle (the
// trial must lapse and revert), no offer to act on.
if (checkin.ok) {
  // settle() takes the completed round, whole: it confirms the running trial,
  // adopts a delivered name, stores a delivered config document, and validates
  // the offer fields. The confirm happens even on an empty response — a
  // completed check-in is the health signal, offer or no offer, so a healthy
  // build cannot roll back just because a newer one was published mid-trial.
  // A body that never decoded to an object (a captive portal's HTML) settles
  // nothing, confirm included.
  const {offer} = ota.settle(checkin.value)

  // Read the config in the same cycle, so a document delivered above can
  // settle its trial on the next completed check-in.
  const config = ota.config()

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
}

// Run your normal cycle.
```

`report()` and `settle()` are the two halves the built-in client runs around its own HTTP
call. The primitives they compose (`running()`, `confirm()`, `parseOffer`, `applyConfig`,
`configState()`) stay available one by one, for a client that must intercept a step; the
[API reference](/api/ota) documents both layers. The offer validation inside `settle`
enforces the scheme, the `.tgz`, the checksum and size. It does not check the download
host: the registry names where the build lives, the checksum vouches for the bytes, and
the update key goes only to the registry.

`applyOffer` runs the whole update sequence. It skips a build that already runs or that
failed before. It enforces the retry limits and runs your download callback. Then it
verifies the result against the checksum and size. Compatibility is the decision of the
registry (see above), and this module does not check it again.

Only `'staged'` means that bytes landed. The application applies them with a restart. The
other outcomes (`'trial-pending'`, `'current'`, `'abandoned'`, `'exhausted'`) say why
nothing was staged. See
[the API reference](/api/ota#ota-applyoffer-offer-download-options).

`'trial-pending'` means that this device still runs a trial build. That build must settle
before the device can take another. Confirm the running build on its own merits, as above.
Do not treat the new offer as the item to handle.

`ota.running()` reports the build that executes now, read from the live app. During a trial
it reports the new build with `trial: true`. After a revert it reports the previous build.
`running()` never reports a build that was only downloaded. So the registry can use it as
an accurate record of what each device runs.

### Resume an interrupted download

If a download stops, the device keeps the bytes that it received. On the next attempt,
`update.resumeOffset` holds the number of staged bytes. Request the rest with an HTTP
`Range` header. Do not start from zero. The final verification hashes the whole staged
file, so a resumed download is as safe as a fresh one.

### Deliver device config

A check-in response can carry a [config document](#device-config) as well as a build. The
cycle above already handles it: `ota.report()` puts the two fields the registry needs in
the body (`configRev`, the held document's rev, and `configError`, a document that failed
its trial), and `ota.settle()` stores what came back. Without the echo the registry serves
the same document at every check-in. Without the error report a document that took the
device down is served again forever, and the operator never learns why.

`settle` places the document by its `version` stamp: a document for the release the device
runs is applied, and one for another release is staged for the build it names and applies
when that build installs. Its `config` field says which happened, and says when nothing
did; `'invalid'` and `'failed'` are the two worth logging. The same write is available on
its own as `ota.parseConfig` + `ota.applyConfig`, with `ota.configState()` producing the
two body fields, for a client that handles the document outside the settle. See
[the API reference](/api/ota#ota-applyconfig-config-options).

A delivered document goes on trial, the same as one the built-in client delivers. The
confirm inside `settle` adjudicates both trials: the build's and the document's. The
config trial has one more gate. It settles only after the app has read the document with
`ota.config()`. So read the config in the same cycle, or the trial waits for the cycle
that does.

Each boot whose first `ota.config()` read serves the document spends one trial boot. On a
device that wakes from deep sleep, every wake is a boot. Raise `trialBoots` (an option on
`settle` and `applyConfig`) above the default of 1 when a check-in can fail for several
cycles in a row, on a modem link or a solar power budget. Otherwise a single failed
check-in rolls back a document that was fine.

### Sync the device name

A device [owns its name](/api/sys#devicename) as a `[rev, name]` pair, and the check-in is
how a rename made in the registry dashboard reaches it. `ota.report()` sends the pair on
every round; when the response carries a `name` pair back, `ota.settle()` adopts it. There
is no rev arithmetic on the device: the registry sends the key only when its rev should
win, and an absent key means "no change", never "clear".

Outside the settle, `mikro/sys` holds the pair: `deviceName()` reads it, and
`setDeviceName()` writes it, for a client that adopts a rename by hand.

### Timing

`mikro/ota` has no timer. The caller decides when to check in and how to run the download.
Only the caller knows its constraints: a connectivity window, a maintenance window, the
cost of the connection, or a limited power budget. The two modes of the built-in client are
those decisions, made for the two common kinds of app. Always-on apps get a jittered background
cadence. Apps that sleep get one check per wake.

## Relation to `mikro dev` and `mikro deploy`

OTA installs the same app build as `mikro dev` and `mikro deploy`, through the same engine.
The three differ only in how the bytes arrive.

| Command        | When                | How it sends            | Rollback target |
| -------------- | ------------------- | ----------------------- | --------------- |
| `mikro dev`    | development         | incrementally, per file | not affected    |
| `mikro deploy` | release, over cable | the whole build         | clears it       |
| OTA            | remote              | the whole build, by you | reverts to it   |

`mikro deploy` stages the build over the cable. The device installs it at the next boot,
before the app loads. The install thus never runs against a heap that the app fragmented.
For OTA state, a cable deploy is like a reflash. The deployed build starts as the
known-good build with no rollback target, and the first OTA update after it has nothing to
revert to. When an update survives its trial, that build becomes the rollback target for
the next one. `mikro dev` stays incremental for a fast edit loop and does not change the
rollback target.

## The registry

A registry stores builds and decides which build each device gets. You operate your own
registry, as an implementation of the OTA registry protocol on your own backend. The
[`@mikrojs/registry`](https://github.com/mikrojs/mikro/tree/main/packages/@mikrojs/registry)
package is a ready-made reference implementation: a portable fetch handler with pluggable
storage and auth. The [ota example](https://github.com/mikrojs/mikro/tree/main/examples/ota)
bundles it as a one-file server (`registry/server.ts`). The
[OTA Registry Spec](/registry-spec) is the contract when you build your own registry.

On your workstation, point the CLI at your registry once:

```sh
mikro ota setup
```

The command asks for the registry url. Then it shows a short code and opens the approval
page in your browser. Type the code there and approve. On a remote machine, the command
prints the link instead.

Setup saves a token that can publish this app and enroll its devices. The token stays out
of git, so you cannot commit it by accident. You do this once. `mikro ota push` and
`mikro ota enroll` use the saved url and token from then on.

## Enroll devices {#enrolling-devices}

A registry answers only authenticated check-ins. Each device authenticates with its own
update key. The registry issues the key when you enroll the device from your workstation:

```sh
mikro ota enroll
```

The CLI reads the hardware id from the connected device and registers it with the registry.
Then it writes the registry url and the returned update key to the device, as a pair. An
update key never travels over the network to the device. The registry returns it exactly
once, in its response to the enrollment request.

On the device, the pair lives in the system store (`mik.sys`). Deploys and
`nvsStorage.clear()` do not touch that store. The app reads the pair with
[`ota.registry()`](/api/ota#ota-registry) and [`ota.bearer()`](/api/ota#ota-bearer).
Enrollment also binds the device to the app of the project. That is the only app the
registry will offer to this device.

An update key can become invalid. A 401 on check-in means that the key was rotated or the
device was deleted. If this occurs, re-enroll at the workstation with
`mikro ota enroll --re-enroll`. That command rotates the update key and invalidates the old
one immediately. The device treats only a 401 this way. Transient errors keep the normal
check-in cadence.

Some registries issue update keys with their own tools. For those registries, write the
secret directly with `mikro ota enroll --update-key <secret>`.

## Build and publish {#building-and-publishing-builds}

```sh
# Create a build from the current project.
mikro ota pack

# Build, pack, and upload it to your registry.
mikro ota push

# Upload and release it to the main channel in one step.
mikro ota push --release main
```

`mikro ota pack` builds your app to bytecode and packs it into a `.tgz`. A small manifest
in the archive records the firmware version and the bytecode version that the build
targets. Use `pack` alone for a build artifact or a manual upload. `mikro ota push` uploads
the build to the registry that `mikro ota setup` configured (`.mikro/registry.json`). The
push authenticates with the stored token. Pass `--registry` and `--token` to override them
for one push.

## Release channels {#release-channels}

A channel is a movable pointer to a build, like a Docker tag or an npm dist-tag. You enroll a
device on one channel, and the registry offers it whatever build that channel points at. The device never knows its channel. The mapping lives in the registry.

An upload and a release are two steps. `mikro ota push` uploads a build, but no device
receives it until a channel points at it. `mikro ota release <version> <channel>` moves a
channel to a build that you already uploaded. `mikro ota push --release <channel>` does
both at once.

The default channel is `main`. A typical flow: enroll test devices on a `beta` channel with
`mikro ota enroll --channel beta`, and serve them with `mikro ota push --release beta`.
When a build is proven, graduate that exact build to everyone with
`mikro ota release <version> main`. To move a channel back to an earlier build, run the
same command with an older version.

## Device config {#device-config}

An app can declare a config schema and receive remote configuration with check-ins. No new
deploy is necessary. Define the schema once in app source. Name it in `mikro.config.ts`.
Read the effective config with [`ota.config()`](/api/ota#ota-config):

```ts
// app/ota.config.ts: one definition types the reads and renders the registry form
import {enumOf, number, object, string} from 'mikro/schema'
import type {InferRead} from 'mikro/schema'

export const ConfigSchema = object({
  interval: number({
    title: 'Check-in interval',
    description: 'How often the device asks the registry for work.',
    unit: 's',
    default: 60,
    min: 30,
    max: 3600,
    integer: true,
  }),
  logLevel: enumOf(
    [
      {value: 'debug', title: 'Debug', description: 'Verbose; not for production.'},
      {value: 'info', title: 'Info'},
      {value: 'warn', title: 'Warning'},
    ],
    {default: 'info'},
  ),
  endpoint: string({title: 'Endpoint', format: 'url'}),
})

// Types ota.config() app-wide; see the ota API reference.
declare global {
  interface OtaConfig extends InferRead<typeof ConfigSchema> {}
}
```

```ts
// mikro.config.ts
import {defineConfig} from 'mikro'
import {ConfigSchema} from './app/ota.config.js'

export default defineConfig({
  otaConfigSchema: ConfigSchema,
})
```

The annotations are what make the operator's form usable rather than a list of field names:
`title` and `description` label a field, `unit` says what the number means, and `min`, `max`,
`integer`, `maxLength` and `format` bound what can be saved. [`enumOf`](/api/schema#enumof-entries)
gives a closed choice list a label per value. `mask` marks a field a form should not show in
cleartext, though it grants no protection beyond that. See [Annotations](/api/schema#annotations)
for the full set.

**Bounds are checked everywhere**: by the registry when an operator saves a value, by
`mikro ota pack` when your defaults are serialized, and by [`parse()`](/api/schema#parse) on the
device. What keeps a bad value off your board is the registry, since a config schema never reaches
a device and the document it stores arrives already validated. `format` is checked only where
config is written, because a device has no regular-expression engine.

`mikro ota pack` serializes the schema into the build, together with the defaults it
materializes: every field a default covers, and nothing else. A registry that implements config
sync stores the schema per release and renders a form from it. The registry stores only the
values that an operator set, and serves only the top-level values that deviate from the
defaults of the release the device runs, each of them complete. The device spreads what it
receives over its own defaults, top level only, and applies the result without a schema of its
own. The defaults of a new release take effect when the build installs.
[The registry spec](/registry-spec#config-sync) carries the normative rules for that exchange.

`ota.config()` is therefore always an object on a device running a deployed build, and the app
needs no `?? fallback`. What can be absent is a single field: one the schema gives no default,
which no operator has set yet. `InferRead` is the type of that shape, which is why the
registration above uses it instead of `Infer` (the type an operator writes against). The one
case that has nothing to serve, a build that carries no readable manifest and holds no stored
document, throws instead of returning a value to branch on. That is a build that never went
through `mikro deploy` or `mikro dev`.

Config values are plaintext end to end: on the wire, in registry storage, and in the NVS
document the device holds, the same as env vars. Credentials belong in env vars instead, set
over the cable with `mikro env set`, which never travel through a registry. A required field
with no default withholds the release from a device until an operator sets a value for it.

A delivered document goes on trial, like an installed build: the device keeps the previous
document until the next completed check-in after the app has read the new one. A value can
pass the schema and still break the app, say a GPIO number the board does not have. Bounds narrow
that window but cannot close it: a usable GPIO set differs per chip and one schema is authored for
every chip an app targets, so `min` and `max` on a pin are an approximation. If the app
crashes before a check-in completes, the device restores the previous document after the
trial boots run out, and reports the failed document to the registry as `configError`. The
registry does not send the failed document again; the operator sees the report and corrects
the values.

A client that brings its own transport delivers documents itself, through `ota.settle` (or
the split form, `ota.applyConfig` and `ota.configState`). See
[Deliver device config](#deliver-device-config).

In development there is usually no registry in the loop: the app reads its schema defaults,
which `mikro deploy` and `mikro dev` ship in the build's manifest. To run a device with
other values, deliver a document the same way production does, through a registry check-in.

## Limitations

- OTA replaces your app build, not the firmware binary.
- The new build, the previous build kept for rollback, and the unpacked app share the
  storage of the device. On a board with the default 1 MB app filesystem, this limits the
  app size for OTA. A larger app needs a larger filesystem partition. `mikro ota pack` prints
  the size of the build it produced, and the device reports its free staging space on every
  check-in, so a registry can withhold a build that does not fit.
- The first OTA update of a device has no rollback target. Neither `mikro dev` nor
  `mikro deploy` sets one (a cable deploy clears it). If that first update fails its trial,
  the device keeps the new build and reports the failure at its next check-in. The recovery
  REPL catches a build that crash-loops. From the REPL, deploy again over a cable. When an
  update survives its trial, later updates revert to the last build that survived.
