# Over-the-air updates

Checks a registry for new app builds in the background and installs them over WiFi, with
the firmware handling the trial and automatic rollback. The companion
[`ota-wake-cycle` example](../ota-wake-cycle) is the deep-sleep variant.

## How it works

`main.ts` is the app (WiFi plus an LED heartbeat), and the whole update machinery is one
call to `otaClient.watch()` from the built-in `mikro/ota/client`:

1. On the first check it reconciles the previous boot's update (installed, or rolled back
   after a failed trial) and reports it to the registry.
2. It checks in on a jittered cadence, sending the build it is running and its
   firmware/bytecode versions. Check-ins authenticate with the device's update key
   (`ota.bearer()`), provisioned over the cable with `mikro ota enroll`, and retry sooner
   after a failed check.
3. If the registry returns an offer, the client streams the `.tgz` straight to flash
   (resuming an interrupted transfer instead of starting over) and restarts so the
   firmware installs the new build.
4. A freshly installed build runs as a trial: the next completed check-in confirms it, and
   a build that boots but cannot reach the registry is rolled back. See the
   [over-the-air updates guide](https://mikrojs.dev/ota).

WiFi stays up for the life of this app, so `otaClient.watch()` needs no options beyond the demo
cadence. A device that powers its radio down between checks brings the network up in the
`beforeCheck` hook and takes it down in the teardown that hook returns. To speak your own
wire instead of the built-in client, the policy layer underneath (`mikro/ota`) is still
open; see the [registry spec](https://mikrojs.dev/registry-spec).

## The registry

This example talks to a registry you run, and ships one: `registry/server.ts` is a minimal server
built on [`@mikrojs/registry`](../../packages/@mikrojs/registry): one operator password and
storage on disk under `registry/data/`.

```sh
REGISTRY_PASSWORD=choose-a-password npm run registry
```

It prints the url devices will use (its LAN address; set `BASE_URL` behind a proxy or when
it picks the wrong interface). Point the CLI at it once:

```sh
npx mikro ota setup
```

It prompts for that url, then shows an approval link and a one-time code: open the link in a
browser, enter the code and the `REGISTRY_PASSWORD` there once, and the registry issues a
token scoped to this app which the CLI saves to `.mikro/registry.json` (gitignored admin
config; the file is plain `{"url": …, "token": …}` if you'd rather write it yourself). The url
is the registry **origin**; the CLI and the device append the `/api/v1` path themselves.
`createRegistry` takes a storage implementation and auth hooks (`verifyAdmin`,
`verifyDevice`), so the same handler can run against whatever backend your server already
has: Node, Bun, Deno, Cloudflare Workers, or any framework that speaks fetch. The check-in
and offer shapes follow the OTA registry protocol; see the
[OTA Registry Spec](https://mikrojs.dev/registry-spec) to build your own from scratch.

## Environment variables

Reads `WIFI_SSID` and `WIFI_PASSPHRASE` via `env.require()`. For local development, create
a `.env` file:

```
WIFI_SSID=YourNetwork
WIFI_PASSPHRASE=YourPassword
```

To set them on the device (persisted in NVS):

```sh
npx mikro env set WIFI_SSID YourNetwork --no-secret
npx mikro env set WIFI_PASSPHRASE            # prompts for value (hidden)
```

The registry url is deliberately not an env var: it is provisioned at enrollment, below.

## Enrollment

The registry answers only authenticated check-ins, so enroll the device once from your
workstation. The CLI reads the device's hardware id, registers it with the registry, and
writes the registry url and the returned update key to the device as a pair:

```sh
npx mikro ota enroll
```

Both land in the device's system store (`mik.sys`), where a deploy and `nvsStorage.clear()`
leave them alone; the app reads them with `ota.registry()` and `ota.bearer()`. On a device
that is not enrolled yet, `otaClient.watch()` returns an error instead of a watcher; this
app logs it (`OTA updates are disabled`) and keeps blinking, and enrolling plus a restart
turns updates on. If the registry
ever answers a check-in with 401 (update key rotated, device deleted), re-enroll with
`mikro ota enroll --re-enroll`; update keys never travel over the network.

### Local testing over http

The device normally refuses plaintext downloads (only `https` build urls are accepted).
The built-in client makes one exception: a provisioned registry url that is `http://`
**on a private network** (`10.x`, `192.168.x`, `172.16–31.x`, `169.254.x`, loopback, or
an `.local` name). That covers the development registry, which serves on your LAN address
so devices can reach it, and pointing `.mikro/registry.json` at it is all local testing
needs.

A plaintext registry on a public host stays refused, and `mikro ota setup` rejects one up
front. The checksum in an offer is no protection over http: whoever can rewrite the url on
the wire rewrites the checksum in the same response. When the exception is in force the
device warns on every boot, so a fleet never runs a forgeable update channel silently.

## Run

```sh
npx mikro deploy    # build and deploy to device (establishes the rollback baseline)
```

## Remote configuration

The blink interval and the LED pin are not code: they are the app's config schema
(`app/ota.config.ts`), declared once and read with `ota.config()`. The same check-ins that carry
updates deliver config, so an operator changes a value in the registry and the running device
picks it up on its next check, with no new release:

```sh
# Which devices exist (the token is in .mikro/registry.json after `npx mikro ota setup`):
curl -H "authorization: Bearer <token>" http://<registry>/api/v1/devices

# Blink faster; the LED follows within a check-in (a minute here):
curl -X PUT http://<registry>/api/v1/devices/<deviceId>/config \
  -H "authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -d '{"values": {"interval": 100}}'
```

A round that changes the config calls the app's `onConfig` hook, and this app restarts the
device there so every value is read once, at the top of `main.ts`. An app that can apply new
values in place would use them from the hook instead and keep running.

The registry stores only what you set; everything else follows the schema defaults, so a new
release that changes a default reaches every device you never configured, through the update
itself. The pin has a default of 15. If your board's LED is elsewhere (8 on many devkits),
set it per device the same way, which is what per-device config is for.

The LED drive is remote-configurable as the `pwm` group: `pwm.freq` is the carrier in Hz
(the 50 Hz default flickers visibly; PUT a few kHz to watch it smooth out live) and
`pwm.duty` is the brightness the breathe peaks at.

The check-in cadence is remote-configurable too: set `checkinInterval` (milliseconds) the
same way. The app reads it when it starts its watcher, and the restart above is what puts a
new value to work, so a device can be told to check in less often without a new release. The
client floors the interval at 30 seconds.

Before the first check-in delivers a document, the app runs on the schema defaults that ship
in the build, so `ota.config()` is an object from the first boot and every defaulted field
already has a value. See the [device config guide](https://mikrojs.dev/ota#device-config).

## Publish an update

To see an update land, change the `interval` **default** in `app/ota.config.ts`, bump the version
in `package.json`, and push it, releasing to the `main` channel so enrolled devices are served
it (the running device picks it up within a minute, on its next background check). Every
device you never configured blinks at the new default the moment the build installs. Config
you set per device survives the update:

```sh
npx mikro ota push --release main
```

`push` uploads the build; `--release main` points the `main` channel at it, which is the
channel a device enrolls on by default. Without `--release` the build is uploaded but served
to no one, which is what you want when staging a build for a `beta` channel first (release it
later with `mikro ota release <version> <channel>`). Devices pick up a released build on their
next check-in.
