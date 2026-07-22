---
title: OTA Registry Spec
description: The contract a server must satisfy to publish builds, enroll devices, and serve update offers to Mikro.js devices
---

# OTA Registry Spec

This is the contract for building an **OTA registry**: the server that hands out app updates to
Mikro.js devices. You run it on whatever backend you already have. The device firmware, the
`mikro/ota` runtime module, and the `mikro ota pack` / `mikro ota publish` / `mikro ota enroll`
commands are all part of the Mikro.js repo. This document describes what your server has to do
for them to work.

The spec has two parts:

- **Required.** The endpoints that the fixed Mikro.js code (the CLI and the runtime) calls.
  Implement these and the whole toolchain works against your server unchanged.
- **Advisory.** The check-in protocol that the reference device app and the reference registry
  use. Adopt it unless one of the [reasons to replace it](#advisory-the-reference-check-in-protocol)
  applies. The device side of a check-in is application code that you write and own, so you can
  replace this half entirely, as long as the required half still holds.

## Background

Mikro.js is a JavaScript runtime for microcontrollers. Its over-the-air (OTA) update system
replaces a device's **app build** (the compiled JavaScript, shipped as a gzipped tar) without a
cable. The device downloads a build over whatever connection its app has, and the firmware
installs it on a trial. If the trial fails, the firmware rolls back automatically.

A **registry** is the server in that system. It stores builds, answers device check-ins with an
update offer (or with nothing), records what each device is running, and provides endpoints for
publishing builds and enrolling devices.

**Base URL and the `/api/v1` prefix.** The registry serves its API under `/api/v1`. Clients are
configured with only the registry's origin: on the workstation through `.mikro/registry.json`
(written by `mikro ota setup`) or `--registry`, and on the device through enrollment, where it
is stored next to the credential. The clients add `/api/v1` themselves. Every endpoint path in
this document is relative to `/api/v1`.

**The identity document.** `GET` the base url (with `Accept: application/json`) returns a small
JSON document identifying the registry:

```json
{"name": "mikro-registry", "version": "<build id>"}
```

`name` must be exactly `mikro-registry`; that is how `mikro ota setup` recognizes a registry before
it commits a token, so a typo'd or wrong url is caught up front rather than at the first publish or
enroll. It warns and asks whether to continue (it does not hard-fail) when the url answers without
this document, since a proxy could rewrite the root. `version` is an optional build identifier (for
example the deployment's commit sha); it is informational, and clients never key on it. Serve a
human page to browsers at the same url if you like; API clients ask for JSON.

## Required: the contract

### 1. The build artifact

`mikro ota pack` produces a gzipped tar. Its root holds `mikro.app.json` plus the `app/` tree.
The manifest is `{app, version, firmwareVersion, bytecodeVersion}`. The last two record what the
build was compiled against; they are not a policy about who may run it.

The build's identity is the **SHA-256 of the `.tgz`, in lowercase hex**. `mikro ota pack`
computes it, and the device firmware verifies it after downloading. Store it and serve it as the
offer's `checksum`. If it does not match, every download fails verification.

### 2. The publish endpoint

`mikro ota publish` uploads a build here. `POST /builds`, `multipart/form-data`:

| Part              | Type             | Value                                                                                    |
| ----------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `app`             | string           | application lineage, from the build's `mikro.app.json`                                   |
| `version`         | string (semver)  | app version, from the build's `mikro.app.json`                                           |
| `checksum`        | string           | SHA-256 (lowercase hex) of the `.tgz`                                                    |
| `size`            | string           | build size in bytes (decimal string)                                                     |
| `firmwareVersion` | string (semver)  | from the build's `mikro.app.json`; must be valid semver                                  |
| `bytecodeVersion` | string           | from the build's `mikro.app.json` (decimal string)                                       |
| `note`            | string, optional | free-text note about the build (omitted when unset)                                      |
| `create`          | string, optional | truthy flag (`--create`): create an unknown app on first publish instead of rejecting it |
| `build`           | file             | the `.tgz` (content-type `application/gzip`)                                             |

Auth is `Authorization: Bearer <token>`. The CLI never parses the token, so any token scheme
works; `--token` and `MIKRO_OTA_TOKEN` are sent verbatim.

Releases are immutable. Publishing the same `(app, version, bytecodeVersion)` again with the
same checksum is a success (a `2xx`), so a CI retry is safe. Publishing it with a different
checksum is a `409`. On any failure, respond with a non-`2xx` status and a text body; the CLI
shows the status and the body to the user.

A minimal registry may ignore `create`, for example by auto-creating apps or serving a single
implicit app. It exists so that a multi-app registry can refuse to start a new app lineage from
a typo in the app name.

Cap request bodies. Publish is the only route that carries more than a few kilobytes. A registry
that buffers bodies has to enforce the limit while reading and answer `413` once it is passed,
not after routing, so that an unauthenticated POST cannot exhaust memory. The reference `serve`
adapter defaults to 16 MiB (`maxBodyBytes`).

### 3. The offer object and the download

The device passes a check-in response body straight to `ota.parseOffer()`. Anything that is not
a valid offer is read as "no update": an empty body, `null`, `{}`, or a `204` all mean that. A
valid offer is:

| Field      | Type             | Meaning                                                          |
| ---------- | ---------------- | ---------------------------------------------------------------- |
| `url`      | string           | HTTPS URL of the `.tgz` build (path must end `.tgz`)             |
| `checksum` | string           | SHA-256 (lowercase hex), the device verifies after download      |
| `size`     | number           | Build size in bytes                                              |
| `version`  | string, optional | The release's app version; shown to operators, unread by devices |

An offer says **what to fetch and how to verify it**, and nothing else. It carries no
`firmwareVersion` or `bytecodeVersion`. Those fields choose which build to offer, and only the
registry can act on them, because only the registry holds the other builds. A device that is
handed a build it cannot run can say "not this one" but never "give me that one instead", so the
choice belongs entirely to the registry (see [Offer selection](#offer-selection)). A registry
that sends the extra fields anyway does no harm: the device ignores fields it does not know.

Because the choice sits with the registry, a custom registry has to implement the offer rules or
its devices will be handed builds they cannot run. A device does not decline such a build
quietly. It installs it, the install fails, the trial rolls it back, and the next check-in
reports the failure through `lastInstall`, which takes the build off that device's list. That
recovery works, but it costs a download and a failed install each time, so it is not a
substitute for choosing correctly.

`parseOffer` rejects an offer whose `url` path is not `https://….tgz`, whose `checksum` is empty,
or whose `size` is not a positive integer. It does not check the `url`'s host. The check-in is
authenticated, so the registry is trusted to say where the build lives, including a CDN or object
store on a different host. (`allowInsecure` lets development setups accept `http`.)

The download must serve the exact bytes at `url`. **Range requests are recommended**
(`Accept-Ranges: bytes`, then `206` with `Content-Range`). The reference client streams the build
straight to flash and resumes an interrupted download from what it already has, so a dropped
connection costs only the remaining bytes. Answering `200` with the whole build is also correct;
the client skips the prefix it already holds. Static storage (S3, a CDN, nginx) provides ranges
for free.

**Authenticating the download.** The download callback is app code, so the device can attach
whatever the URL needs. A registry may pick any of these:

- **The device credential**, which is what the reference registry uses. The download takes the
  same credential as the check-in and answers `401` before revealing whether a build exists, so
  de-enrolling a device stops it downloading. The reference client sends the credential only when
  the URL is on the same origin as the registry it enrolled against, so a URL pointing elsewhere
  never receives it.
- **A signed URL** issued at check-in: short-lived, with the signature in the query string.
  Nothing long-lived is sent, revocation is simply not issuing another, and it works when builds
  live in object storage on a different host. No device change is needed, because the URL is
  opaque to the device.
- **The checksum as an unauthenticated capability.** Simplest, and weakest. Checksums are not
  secret: `mikro ota publish` prints them and they end up in CI logs. Anyone who learns one can
  fetch that build forever, and a de-enrolled device keeps its access.

Whichever you choose, scope the download to the requesting device's app. Authenticating the
device only proves the caller is _a_ device. On a registry that serves more than one app, that
alone would let any enrolled device fetch any other app's build using a checksum from a log.

### 4. The enroll endpoint (optional)

`mikro ota enroll` uses this to set a device up from a workstation. The CLI reads the hardware id
off the connected device, calls the registry, and writes the returned credential back to the
device. A registry that mints credentials some other way can skip this endpoint; users then
provision with `mikro ota enroll --credential <secret>`.

`POST /devices`, JSON body `{deviceId, name?, app?}`, response `{device: {...}, credential:
string}`. The credential is returned exactly once, so store only a hash of it. Auth is an opaque
bearer token. Any tenancy (org, project) is resolved from the token, never from the URL path, so
the CLI uses one path shape against every registry.

`name` is optional on the wire, but `mikro ota enroll` always sends one. It uses an explicit
`--name` if given, otherwise the name already on the device, otherwise a default it derives from
the `deviceId` and writes to the device at the same time. So an enrolled device has a real name
on both sides, and a registry never has to reproduce that derivation to show the same string the
CLI shows (see [Name sync](#name-sync)).

`app` binds the device to one app lineage, the only app it will ever be offered builds for (see
[Offer selection](#offer-selection)). An app-scoped token binds to its own app and rejects a
conflicting `app` with `403`; an unscoped token may name any app. `app` is optional on the wire,
but enrollment is the only place a binding is ever set, so **always send it**. A device enrolled
without one is offered nothing until it is re-enrolled with an app.

If the `deviceId` is already enrolled, respond `409`. The CLI then offers
`POST /devices/:deviceId/credential` (through `--re-enroll`), which returns `{credential}`: a
fresh credential that invalidates the old one the moment it is returned.

Both this endpoint and `GET /devices` are scoped by the token, not just gated by it. An
app-scoped token lists only its own app's devices, and re-minting the credential of a device in
another app returns `404`, not `403`, so the token cannot be used to find out that other apps'
devices exist.

### 5. Browser login (optional)

`mikro ota setup` uses this to get a token without the user pasting one. The CLI asks the
registry for a login session, sends the user to a browser to log in and approve, then polls for
the token. Registries with static or externally issued tokens skip this, and the CLI falls back
to prompting for a token.

`POST /auth/sessions`, unauthenticated. The JSON body may carry context for the approval page:
`{app?: string}`, the app lineage of the project the CLI is running in (from its `package.json`
name). The response is served `Cache-Control: no-store`:

| Field       | Type             | Meaning                                                                                           |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `loginUrl`  | string           | Absolute URL the user opens in a browser to approve. Carries no session; the same value each time |
| `code`      | string           | Session code, the secret used to poll; returned once                                              |
| `userCode`  | string           | Short code the CLI displays; the user types it into the approval page                             |
| `expiresIn` | number           | Seconds until the session expires                                                                 |
| `interval`  | number, optional | Minimum seconds between polls (default 3)                                                         |

`GET /auth/sessions/:code/token` returns `202` while the login is pending, `200` with
`{token: string}` exactly once when it is approved (the registry then discards the session), and
`404` for an unknown, expired, denied, or already-claimed code (the CLI starts over). Served
`Cache-Control: no-store`.

**The two codes do different jobs, and both are needed.** `code` is the secret the CLI polls
with; only the CLI has it. `userCode` is short and easy to type, and the approval page refuses to
approve until the operator types a matching one. Without `userCode`, the session-creation
endpoint would let anyone start a session, send an operator the `loginUrl`, and poll for the
token that the operator's approval mints. `userCode` is what ties the browser doing the approving
back to the CLI that started the session, because only that CLI's terminal shows it.

The CLI prints `userCode` in its own terminal, next to `loginUrl`, so only the operator who
started the session ever sees it. Given that, a registry must:

- Generate `userCode` from an alphabet with no ambiguous characters (no vowels, no `0`/`O`, no
  `1`/`I`/`L`), and compare it case-insensitively, ignoring whitespace and separators, so it
  survives being read off one screen and typed into another. The CLI shows the code exactly as
  sent. The leniency is for what the operator types, not permission to reformat a value that is
  sent back to the registry.
- Put **nothing session-specific in `loginUrl`**: not `code`, not `userCode`, not a per-session
  handle. It is a constant page, and the code the operator types is what selects the session. A
  URL is a poor place for a secret: it lands in server access logs, browser history, and the
  `Referer` header on anything the page links to. Putting the secret in the URL fragment only
  hides it from the server, not from the browser. This is RFC 8628's `verification_uri`. That
  spec also defines `verification_uri_complete`, with the code embedded, and warns against it for
  the same reasons.
- Because the code is now the lookup key, generate one that no live session is already using.
- Reveal nothing until the code is entered. The page should say what approving would grant (which
  app, what the token can do) so that a forwarded link looks suspicious. But showing that to
  anyone who merely opens the URL reveals which app the CLI is authorizing, so ask for the code
  first, then show the grant and ask for the credential.
- Rate-limit a wrong code the same as a wrong credential, so the code cannot be used to probe for
  live sessions.
- Cap how many logins can be pending at once, answering `429` with `Retry-After` past the cap.
  Starting a session is unauthenticated, so without a cap anyone can grow that state without
  bound. Look sessions up by an index rather than scanning them, or the unauthenticated endpoint
  becomes quadratic in the number of pending logins.
- Return the same message for a wrong code and a wrong password, so neither reveals which was
  wrong.
- Rate-limit approval attempts per client address **and** globally, with backoff. The reference
  implementation allows three failures per address before backing off, doubles the delay up to a
  minute, and forgets a count after an hour idle; it answers `429` with `Retry-After` while a
  bucket is backing off. Count an attempt when the request is admitted, not when it fails.
  Everything in between is asynchronous, so a limiter that counts at the end limits round trips
  rather than guesses, and a single burst of concurrent requests slips through.
- Count a wrong credential against the global bucket **even when the code names a live session**.
  Starting a session is unauthenticated, so an attacker can mint their own code and guess the
  credential behind it. The per-address bucket alone does not stop this, because addresses are
  cheap and an attacker with a range of them avoids the backoff by rotating. The global bucket is
  what a distributed guess runs into.
- Consult the global bucket only for a wrong credential. A correct credential, and the CLI's
  high-entropy `code` poll (`GET /auth/sessions/:code/token`, not the `userCode` a person types on
  the approval page), must pass whatever state the bucket is in. Otherwise a sustained guess keeps
  the login flow closed for every operator, and the exemption gives an attacker nothing, since
  using it means already knowing the credential.

Per-address limiting needs the peer address, and a `fetch` handler is not given one: a `Request`
has headers, not a socket. The host adapter has to supply it. The reference Node adapter reads
the connection's remote address and sets it as an internal header (`mikro-client-ip`), overwriting
anything the client sent so it cannot be spoofed, and the registry reads the address from there. A
custom adapter (a Worker, a different server) has to do the same from whatever its platform
exposes, such as `request.cf` or a trusted `X-Forwarded-For` hop. Without it, every caller shares
one bucket and per-address limiting does nothing. The global bucket still applies, so guessing is
still bounded, but the per-address defence is only as good as the adapter makes it.

**The rate-limiting rules above are the reference's realization of a smaller, model-independent
invariant.** State it directly if your credential model is not a shared password. There are two
dimensions. A **per-caller** dimension (the client address here, or an account, or whatever the
platform gives you) may throttle anyone. A **global** dimension may throttle only a caller who has
not proven the secret, a wrong guess: a caller who presents the correct secret passes whatever
state the global dimension is in, and clears it. Charge the per-caller dimension when a request is
admitted, before the async check; charge the global dimension only on a proven wrong guess.
Everything above follows from that.

Name the secret abstractly. The reference has two guessable secrets on the approval page, the short
`userCode` and a shared password, and bounds both. If your second factor is not a guessable secret,
for example when the approver is an already-authenticated session and there is no password to be
"wrong", then the `userCode` is your only guessable secret, and the global dimension must bound its
lookup: treat a wrong `userCode` the way this section treats a wrong password. What never needs the
global bound is the CLI's `code` poll: that `code` is 128-bit, so guessing it is not a threat the
global dimension defends against.

The exemption for a correct secret is safe **because** the global bound already makes guessing the
secret infeasible, not on its own. Thirty-odd free attempts and doubling-to-a-minute backoff over a
20-bit-or-larger space is effectively unguessable, so "using the exemption means already knowing the
secret" holds. Pick a small `userCode` space or a large free-attempt count and that premise breaks,
and the exemption becomes a real hole.

One residual is intended: the secret is checked before the global bucket is consulted, so a fresh
caller always gets exactly one guess before a global `429` can apply. That is fine (one guess over a
large space reveals nothing) and is what lets a correct secret bypass a backing-off bucket. Do not
"fix" it by moving the global check to admission, which would break that exemption. This is the same
reasoning as RFC 8628 §5.1's guidance on brute-forcing the user code.

Browser login mints **a single token**, not one per operation, and it has to authorize
everything the CLI does over a connection: publishing builds (§2) and enrolling devices (§4). The
CLI never parses it, like every other token here. The `app` context lets the registry scope it to
one project: a token good for publishing that one app and enrolling that app's devices, rather
than inheriting the approving user's full authority.

**Tokens expire and can be revoked.** A minted token carries an expiry (the reference
implementation uses 90 days) and is refused past it. A stored token with no readable expiry is
treated as expired, not as eternal. Record a coarse last-used time so an operator can see which
tokens are still live. The reference implementation exposes these to the registry secret only (a
minted token gets `403`):

- `GET /auth/tokens`, returning `{tokens: [{tokenHash, app?, createdAt, expiresAt, lastUsedAt?}]}`.
  It returns hashes, never tokens: the hash is how a token is named after it has been handed out.
- `DELETE /auth/tokens/:tokenHash`, returning `200`, or `404` if there is no such token. The token
  stops working immediately.

Because a token can be revoked, the CLI treats a `401` on a token that was working as "this token
is gone" and points the user back at `mikro ota setup`, rather than retrying it as a temporary
failure.

**Discovery is the endpoint itself.** `mikro ota setup` sends `POST /auth/sessions`, and a `404`
or `405` means the registry does not support browser login. No `401` anywhere needs a special
shape: a rejected command points the user at `mikro ota setup`, which finds out again whether
login is supported on its next run.

Security notes. The `code` is the only thing needed to claim the token, so it must be
high-entropy (128 bits or more), short-lived (minutes), and known only to the CLI that started the
session. The login page should show what is being authorized (which registry, and that a CLI
requested it) so that a forwarded `loginUrl` looks suspicious to the person approving. The page
must not be cached (`Cache-Control: no-store`). Compare submitted secrets in constant time, or by
comparing digests of both sides rather than the secrets directly.

## Advisory: the reference check-in protocol

The device side of a check-in is application code, so none of this section binds you. It is what
the reference client and the reference registry speak, and what the hosted mikro-registry builds
on. Replace it freely, and keep the required half.

Nothing in the fixed Mikro.js code sends the check-in request: the CLI and the runtime never call
`/checkin`. Only the reference `examples/ota/app/updates.ts`, a file you copy and own, does. The
runtime gives you the pieces around it: `ota.parseOffer`, `ota.applyOffer` (with a download
callback you write), `ota.bearer()`, `ota.registry()`, and `ota.reconcile()`. How the device asks
a server what to run is up to you. Reasons to write your own instead of adopting this one:

- **A different transport.** This is an HTTPS `POST`. Devices on MQTT, CoAP (Thread or another
  mesh), BLE, or LoRaWAN run the "is there an update?" exchange over that instead. `applyOffer`
  takes bytes from any link.
- **An existing device backend.** A fleet platform that already authenticates devices and signals
  firmware (your own, AWS IoT, Balena, and so on) can drive OTA directly. It names a build as
  `{url, checksum, size}`, the app builds an `Offer` from that, and calls `applyOffer`. There is
  no second protocol to stand up.
- **Push instead of poll.** This polls at startup. A backend that pushes over a live connection
  skips the check-in and calls `applyOffer` when it has something.
- **A different auth model.** This uses a bearer credential minted at enrollment. Mutual TLS,
  signed JWTs, or a hardware security module would replace it. Enrollment (§4) is itself optional,
  so a fleet can provision credentials its own way.
- **Side-channel delivery.** Builds from an SD card, a UART gateway, or pinned into the app need no
  server at all. Get the bytes, and verify the checksum through `applyOffer`.

Adopt the reference when you are building a plain registry server for WiFi devices and want the
`examples/ota` flow to work against it unchanged. That is the common case, and why it is the
reference.

### `POST /checkin`

Auth is `Authorization: Bearer <device credential>` (from `ota.bearer()`), minted at enrollment.
**Credentials never travel in check-in responses.** A `401` means the credential no longer works
(it was re-minted, or the device was deleted), and the device needs to be re-enrolled at a
workstation. Devices treat only a `401` this way; a temporary error keeps the credential and the
normal cadence. There is no fallback secret and no pending state.

Request body (JSON):

| Field          | Type                               | Meaning                                              |
| -------------- | ---------------------------------- | ---------------------------------------------------- |
| `deviceId`     | string                             | Hardware-derived id the device reports about itself  |
| `firmware`     | string (semver)                    | Firmware version                                     |
| `firmwareHash` | string                             | Firmware build hash                                  |
| `bytecode`     | integer                            | Bytecode version the device can load                 |
| `board`        | string, optional                   | Chip or board target (for future firmware targeting) |
| `running`      | map `{checksum?, version?, trial}` | The build executing right now                        |
| `lastInstall`  | map `{reason, detail?}`, optional  | Diagnostic from a failed install, sent once          |
| `name`         | `[rev, name?]`, optional           | The device's name and revision (see Name sync)       |
| `free`         | integer, optional                  | Bytes free to download and stage one build           |

`running` is read from the live app. A device that has only staged a build still reports its
previous build until the new one is actually executing, so `running` is never a guess.

Every field here is untrusted input that ends up in a stored record, so validate the shapes and
cap the lengths rather than storing whatever arrives. The reference implementation answers `400`
with `{"error": "Invalid <field>"}` for a malformed field instead of dropping it silently. It
requires `running.checksum` to match `^[0-9a-f]{64}$`; `running.version` and `firmware` to be at
most 64 characters; `bytecode` to be an integer; `lastInstall` to be exactly `{reason, detail?}`
with `reason` at most 64 characters and `detail` at most 256, with unknown keys dropped; and
`name` at most 64 characters. `deviceId` at enrollment is capped at 128 characters. A `400` is not
a `401`, so the device keeps its credential and its normal cadence.

`free` stops a registry offering a build the device has no room for. Without it, that failure
shows up only once the download is under way and the staging write hits a full filesystem.
Implement it unless you have a reason not to.

It is still optional on the wire, because a device may replace this whole protocol, so a registry
has to behave sensibly when `free` never arrives. A device that has never reported `free` is not
size-gated at all. A check-in that omits `free` leaves the last reported value in place rather
than clearing it, so the gate keeps using the most recent report.

A registry that uses `free` should offer a build only when its `size` fits, and **withhold the
offer entirely rather than offering a smaller build**. The device is asking for the newest build
it can hold, not the largest one that happens to fit. The value is the bytes free where the build
is downloaded and staged, which the reference client reads from the app filesystem
(`storageUsage().free` in `mikro/sys`).

The response is the offer object from the required half, or nothing. The response may carry extra
top-level fields, and **devices ignore fields they do not know**. That is how future extensions
are added (the hosted registry uses it for device config sync).

### Identity

The credential is the identity. Key device records by the hash of the credential, and treat the
self-reported `deviceId` as a label chosen at enrollment.

The display name is editable from **both** ends: renamed in the registry, or over the cable with
`mikro name set`. So it is synchronized between the two sides rather than owned by one.

Enrollment always sets a name (§4), so a registry only ever sees devices that have one, and shows
it as stored. The id-derived default is a **seed**, used once at enrollment, not a shared
algorithm. No registry has to reproduce it, and changing it can never silently rename devices that
already exist. An unenrolled device may have no stored name, in which case the CLI derives one for
display on the spot.

Because the enroll endpoint carries no revision, a freshly enrolled device holds its name at
revision 1 while the registry has it at revision 0. The first check-in reconciles that under rule
1 below, with no visible effect. If the name was edited in the registry before that first
check-in, it reconciles under rule 4 instead, and the registry's edit wins, which is what you
want.

### Name sync

A wall-clock timestamp cannot decide a rename, because a device may have no valid time before it
reaches an NTP server. So each side stores the name with a **logical revision**, and every
deliberate rename adds one to it. Both the check-in request and its response carry the name and
revision as one field:

```
"name": [rev, name]     // named, at revision `rev`
"name": [rev]           // name cleared at revision `rev`
                        // field omitted entirely = no change, or not supported
```

The name and revision travel together, so a name can never be seen at the wrong revision.
Clearing a name is a normal write with a higher revision, so a deletion propagates instead of the
old name coming back.

Given the device's name and revision at check-in, the registry compares revisions:

| Case                                  | Registry                                    | Response          |
| ------------------------------------- | ------------------------------------------- | ----------------- |
| 1. Device revision higher             | adopts the device's pair                    | no `name` field   |
| 2. Registry revision higher           | keeps its own                               | its `[rev, name]` |
| 3. Equal revisions, same name         | in sync, nothing happens                    | no `name` field   |
| 4a. Equal revisions, registry unnamed | adopts the device's name                    | no `name` field   |
| 4b. Equal revisions, different names  | registry wins, stores its name at `rev + 1` | `[rev + 1, name]` |

Rule 4b is the concurrent-edit case: both sides renamed the device before either synchronized.
The registry wins so that the two sides converge and do not flip back and forth. The loss is
visible: whoever renamed the device at the serial port sees it change back, and can redo the
rename, which then wins at a higher revision.

Rule 4a tells "never named" apart from "deliberately cleared", and the revision is what
distinguishes them. A registry that cleared a name has a revision recording that it did, while one
that never had a name sits at revision 0. Without this split, a device enrolled without a name
would meet its own seed name at revision 0, which reads as a concurrent edit and orders the device
to clear the only name either side has.

A device that receives a `name` field adopts and stores it. **A response with no `name` field
always means "no change"** and must never be read as an instruction to clear the name. A response
lost after a rule-1 adoption looks the same as one that never arrived, and re-sending the same
pair at the next check-in settles it as rule 3.

Compatibility: firmware that sends no `name` field keeps its previous behavior, so engage sync
only when the field is present. A registry that stores no revision treats old records as revision 0. That leaves one accepted migration case: a device renamed over the cable before the registry
learned about revisions reports revision 1 against a legacy 0, so the device's name wins that
first sync even if the registry had renamed it earlier. This happens once, corrects itself, and
favors whoever has the hardware in hand.

### Offer selection

**The app is the device's, never the check-in's.** A device is bound to one app lineage at
enrollment (§4), and that binding decides which app's builds it may be offered. `running.checksum`
is a status report, not a routing input. Deriving the app from it would let any enrolled device
pull any app's build by naming that app's checksum. A registry that sees a device reporting a
build that belongs to another app should log the mismatch and keep offering only the device's own
app.

The same holds for a device with no binding yet (an older enrollment, or an unscoped token that
named no app). **An unbound device is offered nothing and stays unbound.** A registry must not
infer the binding on the first check-in: not from the build the device reports running (as above),
and not from being the only app on the registry (true today, false the moment a second app is
published, and the devices bound to the first keep that binding). Withholding is the safe answer
to a binding that no one has made.

**Bind at enrollment.** It is the one point where the operator says which app a device belongs to,
and the recommended pattern is to always name it: pass `app`, or enroll with an app-scoped token,
which supplies its own. A registry does not have to refuse an enrollment without one, and this one
does not. Whether an unbound device is an error or a device awaiting a decision is the operator's
call, not the registry's. The only consequence is that it receives nothing until it is re-enrolled
with an app.

Keep one **current build** per `(app, bytecodeVersion)`; publishing makes a build current. This
has to hold for a release that was published before, too. Re-publishing an earlier release is the
documented way to downgrade, so an already-stored build stays idempotent in what it writes but
still becomes current. Track "current" explicitly rather than deriving it from a creation
timestamp, and give it a total order, so that two publishes in the same millisecond cannot leave
"current" ambiguous.

Given a check-in, offer the current build only when all of these hold:

1. The device is bound to an app, and a current build exists for that app at the device's
   `bytecode`. If no build matches the bytecode, offer nothing: the device needs a firmware
   reflash first, which happens out of band.
2. `build.checksum != running.checksum`, so you do not offer what is already running.
3. `device.firmware` satisfies `^build.firmwareVersion` (npm caret semantics): at or above the
   build's firmware version, within its left-most non-zero segment. That is the major for `1.x`
   (`^1.3.0` serves `1.9`, not `2.0`) and the minor for `0.x` (`^0.16.0` serves `0.16.x`, not
   `0.17`). During `0.x`, semver treats a minor bump as breaking, so a plain "same major" check
   does nothing there, since every `0.x` version shares major `0`. This is not an open-ended
   floor: the caret boundary is where breaking changes are. `bytecodeVersion` does not cover them,
   because it tracks the engine, and a release can remove a `mikro/*` API without changing QuickJS.
   A firmware version that is not valid semver withholds the offer rather than widening the gate.
4. The checksum has not failed on this device before. `lastInstall` reports failures, and the
   device also refuses to re-download a build it has abandoned.

The device record is what these are read from, so, as with `free`, the most recent reported
`firmware` and `bytecode` stand when a check-in leaves them out.

Failures must not be permanent. A build can fail for a reason that is later fixed (a full
filesystem, a bad network), and a device whose failure list grows forever eventually refuses every
build. So bound the list (the reference implementation keeps the 16 most recent) and give
operators a way to clear it: `DELETE /devices/:deviceId/failures`, returning `200`, scoped by the
token like the other device routes (`404` outside its app).

### Success tracking

Record `running` and `lastInstall` on every check-in. An update **succeeded** when a later
check-in reports `running.checksum == offeredChecksum` with `running.trial == false`. A download,
a staged build, or a build still on trial is not success. This is why `trial` is required whenever
`running` is sent: if it is left to stand from a previous check-in, it never turns false, and the
update never reads as having landed.

Clear the recorded offer once it succeeds. `lastInstall` carries no checksum, so a failure report
is attributed to whatever was offered last. If a settled offer stays on record, an unrelated later
diagnostic marks the build the device is running as failed, and rule 4 above then withholds the
one build known to work on it.

## Suggested data model

- **builds**: `checksum` (primary key), `app`, `version`, `bytecodeVersion`, `firmwareVersion`,
  `size`, `storageRef`, `createdAt`, `promotedAt` (the highest `promotedAt` per
  `(app, bytecodeVersion)` is current).
- **devices**: `deviceId` (primary key), `credentialHash`, `app` (the binding, set at enrollment,
  nullable), `name` (nullable), `lastSeen`, `runningChecksum`, `runningVersion`, `trial`,
  `lastFirmware`, `lastBytecode`, `lastFree`, `lastInstall`, `failedChecksums` (bounded).
- **tokens**: `tokenHash` (primary key), `app` (nullable), `createdAt`, `expiresAt`, `lastUsedAt`.

File-backed storage with no database is enough for a reference implementation. Records are keyed
by untrusted strings (device ids, token hashes), so a store that indexes them into a plain object
must use a null-prototype object, or `Object.hasOwn` guards. Otherwise `constructor` and
`__proto__` read as existing entries, and writing them corrupts the index.

Keep internal errors in the server log, not the response. A `500` body that echoes an exception
message can hand out filesystem paths. Return a fixed message instead.

## Non-goals

- Producing builds (the CLI does this).
- OTA of the firmware binary (app builds only).
- Any device-side logic; the device and the CLI are implemented in the Mikro.js repo.

## Accepted risks

Two properties follow from the design above. Both are deliberate, and implementers should know
they are choices, not oversights.

**Builds are not signed.** Integrity rests on the SHA-256 in the offer, which arrives in the same
response as the URL, so a registry that answers a check-in decides what the device runs. TLS is
what keeps that authority with the real registry, which is why §3 requires `https`. The
consequence is that compromising a registry means running code on the whole fleet. Recovery may
need physical access: a cleaned-up registry can push a good build over the air, but only if the
build already running still runs the update cycle at all. Signing builds against a key burned in
at flash time would separate "who serves the bytes" from "who may authorize code", and reduce a
registry compromise to a denial of service. It is not part of this version.

**The registry does not block downgrades.** This is about the registry, not the device: the
firmware still rolls back a build that fails its trial. What a registry does not do is stop a
_deliberate_ downgrade. Offer selection follows whichever build is current, and publishing is what
sets "current", so publishing an older build is itself the downgrade. The registry never checks
whether an offer is older than what a device is running. A publisher can therefore move a fleet to
any earlier build, including one with a known defect. Registries that need to prevent this should
refuse to publish a version below the current one, or track a per-app counter that only moves
forward.

## References

- **The reference client is `examples/ota/app/updates.ts`** in the Mikro.js repo, an example you
  copy and adapt rather than a fixed client: it shows the `/checkin` request, how it consumes an
  offer (`ota.parseOffer`), and the streaming download.
- Device and CLI behavior: the [Over-the-air Updates guide](/ota) and the
  [`ota` API reference](/api/ota).
