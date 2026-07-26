---
title: ota/client
description: Built-in OTA update client - check in, download, install, confirm
---

# ota/client

```ts
import * as ota from 'mikro/ota/client'
```

The built-in update client: it checks in with the registry the device was enrolled against,
downloads and stages an offered build, restarts to install it, and confirms the trial of a
freshly installed build. It is the device half of the check-in protocol in the
[registry spec](/registry-spec), speaking CBOR over HTTPS, and it sits on top of the
[`mikro/ota`](/api/ota) policy layer, which stays available for apps that bring their own wire.

An un-enrolled device is a no-op: enrollment (`mikro ota enroll`) is the opt-in, and the
client reads the registry url and update key it provisioned. Connectivity is your app's
business: the client never touches `mikro/wifi`; bring the network up before a check (or in
the `beforeCheck` hook in watch mode).

There are two modes, one per app. Do not combine them: overlapping checks are queued one
behind the other, but the two cadences fight over the same update state.

## ota.check(options?)

```ts
check(options?: CheckOptions): Promise<CheckResult>
```

One update check, for wake-cycle apps: reconcile the previous boot's update, check in
(confirming the running trial if the check-in completes), and download and stage any offered
build. It never restarts the device: on `{status: 'staged'}` your app calls `restart()` once
its in-flight work is done, and the firmware installs the build on the way back up.

```ts
import * as ota from 'mikro/ota/client'
import {deepSleep} from 'mikro/sleep'
import {restart} from 'mikro/sys'

const checked = await ota.check({trialBoots: 3})
if (checked.status === 'staged') restart()
// ...the cycle's work...
deepSleep(60 * 60_000)
```

The result says what happened, and only `'staged'` requires action:

```ts
type CheckResult =
  | {status: 'staged'; offer: Offer} // armed; restart when ready
  | {status: 'up-to-date'}
  | {status: 'not-staged'; reason: DeclineReason; error?: OtaError}
  | {status: 'failed'; error: CheckError} // check-in never completed
  | {status: 'unauthorized'} // 401: re-enroll over the cable
  | {status: 'not-enrolled'}
```

`'not-staged'` means an offer arrived but was not armed; `reason` is the policy outcome
(`'current'`, `'exhausted'`, …) or `'download-failed'`/`'install-failed'` with the error
attached. `'failed'` is transient (network, a bad response) and, importantly, does **not**
confirm a running trial: a build that cannot complete a check-in is the build that should
revert.

Every _expected_ outcome is a value, but a genuinely unexpected throw (say, an
out-of-memory error inside the native HTTP layer) rejects the promise rather than being
swallowed. Watch mode contains those; a one-shot caller that does not catch them halts
loudly, restarts, and checks again next cycle.

## ota.watch(options?)

```ts
watch(options?: WatchOptions): Watcher
```

Periodic update checks, for always-on apps: a detached background loop that runs a check on a
jittered cadence, retries sooner after a failed check, and **restarts the device by itself**
after staging a build. It returns immediately; the loop never rejects, and a crashed check is
contained and retried.

```ts
import * as ota from 'mikro/ota/client'

ota.watch({checkinIntervalMs: 30 * 60_000})
```

A device that powers its radio down between checks brings it up per round with `beforeCheck`.
The hook returns the matching teardown, so everything the round needs lives in one scope:

```ts
import {err, ok} from 'mikro/result'

const watcher = ota.watch({
  checkinIntervalMs: 30 * 60_000,
  beforeCheck: async () => {
    const conn = await wifi.connect({ssid, passphrase})
    if (!conn.ok) return err(conn.error) // round skipped, retried sooner
    return ok(() => wifi.disconnect()) // teardown: runs after the round
  },
})
```

The teardown runs after its round settles (after the check and any download, including
before a restart), and a `beforeCheck` failure skips the round without running it.

`watcher.stop()` cancels the pending sleep and prevents future rounds. A round already in
flight completes, but a build it stages no longer auto-restarts: it stays armed for the next
natural reboot.

## Options

All options are optional.

| Option              | Default   | Meaning                                                      |
| ------------------- | --------- | ------------------------------------------------------------ |
| `checkinTimeoutMs`  | `10_000`  | Wallclock budget for the check-in round trip                 |
| `downloadTimeoutMs` | `300_000` | Wallclock budget for the build download (cancels mid-stream) |
| `requireConfirm`    | `true`    | Keep an installed build only once a check-in completes       |
| `trialBoots`        | `1`       | Clean boots an unconfirmed build survives before reverting   |

Watch mode adds:

| Option                | Default     | Meaning                                               |
| --------------------- | ----------- | ----------------------------------------------------- |
| `checkinIntervalMs`   | `1_800_000` | Steady cadence, end of one round to start of next     |
| `initialDelayMs`      | `5_000`     | Delay before the first round                          |
| `retryAfterFailureMs` | `60_000`    | Cadence after a failed round (capped at the interval) |
| `jitter`              | `true`      | Spread every sleep by ±10%                            |
| `beforeCheck`         | —           | Per-round network setup; returns the teardown         |

By default every scheduled sleep is jittered by ±10% so a fleet that lost power together
does not check in phase-locked forever. Pass `jitter: false` for exact intervals, at the
cost of that spread: useful when watching for an update to land, or on a single device
where the spread only delays it.

### `trialBoots` on a wake cycle {#trialboots-on-a-wake-cycle}

A deep-sleep wake counts as a **clean trial boot**. With `requireConfirm` and the default
`trialBoots: 1`, a build installed on one cycle must complete a check-in within the next
wake or two; a single wake without WiFi is enough to roll back a perfectly healthy build.
Wake-cycle apps on networks that flake should raise it (the
[example](https://github.com/mikrojs/mikro/tree/main/examples/ota-wake-cycle) uses
`trialBoots: 3`): a healthy build then rides out offline wakes, while a build that can never
reach the registry still reverts.

## What a check does

Each check runs the same sequence in both modes:

1. Once per boot, `ota.reconcile()`: what happened to the previous update is logged and
   reported to the registry (the report is held until a check-in actually completes).
2. POST the check-in (device identity, the running build, the name pair, free staging
   space) as CBOR to `<registry>/api/v1/checkin`, authenticated with the update key. A
   registry that does not accept CBOR fails the check with a clear "upgrade the registry"
   error.
3. On a completed check-in: confirm the running trial (see below), adopt a device name the
   registry sent down, and validate any offer.
4. On an offer: stream the build straight to flash with `mikro/ota`'s staging session,
   resuming an interrupted download with a Range request, and attach the update key only when
   the build url is on the registry's own origin.

The client confirms on **any completed check-in**, before taking the offer, and it does so
unconditionally: the `requireConfirm` option decides what happens to a build that _never_
completes a check-in, not whether the client confirms. A completed check-in shows the build
boots and its network path works; it does not prove the rest of your app works. If that
signal is too weak for your app (it can hang after checking in, stuck in a state a reboot
would not clear), this client cannot express a later confirm, because its first check-in
resolves the trial either way. Move the confirm past a point only a working build reaches
by driving the policy layer yourself (see below), or keep the client and guard against the
hang with a hardware watchdog the app must feed.

Plaintext registries are refused except `http://` on a private network (LAN, loopback,
`.local`), which is the development setup; the device then warns on every boot.

## Rolling your own

Everything the client does is built on the public [`mikro/ota`](/api/ota) policy layer, and
the [registry spec](/registry-spec) documents the wire. An app on a different transport
(CoAP, BLE, an existing fleet backend) skips this module and drives `applyOffer` itself; the
[guide](/ota#writing-your-own-client) shows the shape.
