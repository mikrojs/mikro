# Over-the-air updates

Checks a registry for new app builds in the background and installs them over WiFi, with
the firmware handling the trial and automatic rollback. The companion
[`ota-wake-cycle` example](../ota-wake-cycle) is the deep-sleep variant.

```sh
pn create mikro -- --template ota
```

## How it works

`main.ts` is the app (WiFi plus an LED heartbeat), and the whole update machinery is one
call to `ota.watch()` from the built-in `mikro/ota/client`:

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

WiFi stays up for the life of this app, so `ota.watch()` needs no options beyond the demo
cadence. A device that powers its radio down between checks brings the network up in the
`beforeCheck` hook and takes it down in the teardown that hook returns. To speak your own
wire instead of the built-in client, the policy layer underneath (`mikro/ota`) is still
open; see the [registry spec](https://mikrojs.dev/registry-spec).

## The registry

This example talks to a registry you run, and ships one: `registry/server.ts` is a minimal server
built on [`@mikrojs/registry`](../../packages/@mikrojs/registry) — one operator password,
storage on disk under `registry/data/`, and `GET /ping` answering `pong`:

```sh
REGISTRY_PASSWORD=choose-a-password pn registry
```

It prints the url devices will use (its LAN address; set `BASE_URL` behind a proxy or when
it picks the wrong interface). Point the CLI at it once:

```sh
pn mikro ota setup
```

It prompts for that url, then shows an approval link: open it in a browser, enter the
`REGISTRY_PASSWORD` there once, and the registry mints a token scoped to this app
which the CLI saves to `.mikro/registry.json` (gitignored admin config; the file is plain
`{"url": …, "token": …}` if you'd rather write it yourself). The url is the registry
**origin**; the CLI and the device append the `/api/v1` path themselves. `createRegistry` takes a storage implementation and auth hooks
(`verifyAdmin`, `verifyDevice`), so the same handler can run against whatever backend your
server already has — on Node, Bun, Deno, Cloudflare Workers, or behind any framework that
speaks fetch. The check-in and offer shapes follow the OTA registry protocol; see the
[OTA Registry Spec](https://mikrojs.dev/registry-spec) to build your own from scratch.

## Environment variables

Reads `WIFI_SSID` and `WIFI_PASSPHRASE` via `env.require()`, and optionally `LED_PIN` (a
GPIO to blink as a visible heartbeat). For local development, create a `.env` file:

```
WIFI_SSID=YourNetwork
WIFI_PASSPHRASE=YourPassword
```

To set them on the device (persisted in NVS):

```sh
pn mikro env set WIFI_SSID YourNetwork --no-secret
pn mikro env set WIFI_PASSPHRASE            # prompts for value (hidden)
```

The registry url is deliberately not an env var: it is provisioned at enrollment, below.

## Enrollment

The registry answers only authenticated check-ins, so enroll the device once from your
workstation. The CLI reads the device's hardware id, registers it with the registry, and
writes the registry url and the returned update key to the device as a pair:

```sh
pn mikro ota enroll
```

Both land in the device's system store (`mik.sys`), which deploys and `nvsStorage.clear()`
never touch; the app reads them with `ota.registry()` and `ota.bearer()`. If the registry
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
pn mikro deploy    # build and deploy to device (establishes the rollback baseline)
```

## Publish an update

To see an update land, change `BLINK_INTERVAL_MS` in `app/main.ts`, bump the version in
`package.json`, and push it, releasing to the `main` channel so enrolled devices are
served it (the running device picks it up within a minute, on its next background check):

```sh
pn mikro ota push --release main
```

`push` uploads the build; `--release main` points the `main` channel at it, which is the
channel a device enrolls on by default. Without `--release` the build is uploaded but served
to no one, which is what you want when staging a build for a `beta` channel first (release it
later with `mikro ota release <version> <channel>`). Devices pick up a released build on their
next check-in.
