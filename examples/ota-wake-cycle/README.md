# Over-the-air updates on a wake cycle

A deep-sleep device that checks for updates once per wake: connect, `otaClient.check()`,
restart if a build was staged, do the cycle's work, and sleep again. The companion
[`ota` example](../ota) is the always-on variant (`otaClient.watch()`) and ships the registry
server this one talks to.

## How it works

`app/main.ts` runs one cycle per wake:

1. Connect WiFi and call `otaClient.check()` from `mikro/ota/client`. One call does the whole
   check: it reconciles the previous update, checks in with the registry (confirming a
   build installed on the previous cycle), and downloads and stages any offered build.
2. On `{status: 'staged'}`, restart. The firmware installs the staged build and the next
   cycle runs the new code. Any other status just means "carry on": do the cycle's work
   and go back to sleep.
3. `deepSleep()` until the next cycle.

The one setting that matters on a wake cycle is `trialBoots`. A freshly installed build
runs as a trial, a completed check-in is what confirms it, and **a deep-sleep wake counts
as a clean trial boot**. With the default `trialBoots: 1`, one wake without WiFi would
roll back a healthy build; the example passes `trialBoots: 3` so a build gets three wakes
to reach the registry before the firmware reverts it.

## Bounding the wake cycle

`mikro.config.ts` sets an awake limit:

```ts
watchdog: {awake: 120_000},
onPanic: {mode: 'deepSleep', delay: 0, duration: 60_000},
```

A cycle that never ends, because WiFi never associates or a fetch never settles, would
keep the device awake until the battery is flat. The awake limit cuts the cycle at two
minutes and `onPanic` deep-sleeps for the normal interval, so the device stays on its
schedule and checks in again on the next wake. Nothing in app code can extend the limit.

Two minutes is far above a normal cycle here, which takes a few seconds. It has to clear
the slowest cycle instead: WiFi retries, a TLS handshake, the check-in, and a full download
in one wake. A limit shorter than a download does not stop the update, since downloads
resume on the next wake, but every cut cycle pays the WiFi and TLS setup again. Keeping
the check-in at the top of the cycle, as this example does, means a device stuck in a bad
cycle still receives the fix over the air. See the
[watchdog docs](https://mikrojs.dev/api/watchdog) for the other limits.

## Registry, enrollment, and environment

Identical to the [`ota` example](../ota#the-registry): run its registry
(`npm run registry` there), point the CLI at it with `npx mikro ota setup`, set `WIFI_SSID`
and `WIFI_PASSPHRASE`, and enroll the device once with `npx mikro ota enroll`.

## Run

```sh
npx mikro deploy    # build and deploy to device (establishes the rollback baseline)
```

Then publish a change from this directory and watch it land on a later wake:

```sh
npx mikro ota push --release main
```
