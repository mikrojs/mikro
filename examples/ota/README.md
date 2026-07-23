# Over-the-air updates

Checks a registry for a new app build on boot and installs it over WiFi, with the
firmware handling the trial and automatic rollback.

```sh
pn create mikro -- --template ota
```

## How it works

The app runs inside the update cycle: `main.ts` is the app (WiFi plus an LED heartbeat),
and it hands itself to `withUpdates()` from `updates.ts`, which checks once at startup:

1. Calls `ota.reconcile()` on boot to see what happened to any previous update (installed,
   or rolled back after a failed trial), and reports it on the next check-in.
2. POSTs a check-in to the registry, including the build it is `running()` and its
   firmware/bytecode versions. Check-ins authenticate with the device's credential
   (`ota.bearer()`), provisioned over the cable with `mikro ota enroll`.
3. If the registry returns an offer, downloads the `.tgz` and stages it with
   `ota.applyOffer()`, then restarts so the firmware installs the new build. The check-in
   runs before the app starts, so a pending update installs first; updates published later
   are picked up at the next startup.
4. A freshly installed build runs as a trial: if it survives a clean cycle it is kept; if it
   crashes, the firmware reverts to the previous build. See the
   [over-the-air updates guide](https://mikrojs.dev/ota).

The download is the only transport code. This example range-fetches from
`update.resumeOffset` and writes each chunk straight to flash, so a build never has to fit
in RAM and an interrupted transfer resumes instead of starting over. Swap it for whatever
link your device has.

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
writes the registry url and the returned credential to the device as a pair:

```sh
pn mikro ota enroll
```

Both land in the device's system store (`mik.sys`), which deploys and `nvsStorage.clear()`
never touch; the app reads them with `ota.registry()` and `ota.bearer()`. If the registry
ever answers a check-in with 401 (credential re-minted, device deleted), re-enroll with
`mikro ota enroll --re-enroll`; credentials never travel over the network.

### Local testing over http

The device normally refuses plaintext downloads (`ota.parseOffer` accepts only `https`
build urls). This example passes `{allowInsecure: true}` when the provisioned url is
`http://` **on a private network** — `10.x`, `192.168.x`, `172.16–31.x`, `169.254.x`,
loopback, or an `.local` name. That covers the development registry, which serves on your
LAN address so devices can reach it, and pointing `.mikro/registry.json` at it is all local
testing needs.

A plaintext registry on a public host stays refused, and `mikro ota setup` rejects one up
front. The checksum in an offer is no protection over http: whoever can rewrite the url on
the wire rewrites the checksum in the same response. When the exception is in force the
device warns on every boot, so a fleet never runs a forgeable update channel silently.

## Run

```sh
pn mikro deploy    # build and deploy to device (establishes the rollback baseline)
```

## Publish an update

The app code lives in `app/main.ts` (WiFi + LED heartbeat); all the update machinery is in
`app/updates.ts`, ready to copy into your own app. To see an update land, change
`BLINK_INTERVAL_MS` in `app/main.ts`, bump the version in `package.json`, and push it,
releasing to the `main` channel so enrolled devices are served it:

```sh
pn mikro ota push --release main
```

`push` uploads the build; `--release main` points the `main` channel at it, which is the
channel a device enrolls on by default. Without `--release` the build is uploaded but served
to no one, which is what you want when staging a build for a `beta` channel first (release it
later with `mikro ota release <version> <channel>`). Devices pick up a released build on their
next check-in.
