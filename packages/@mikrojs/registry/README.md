# @mikrojs/registry

Reference OTA update registry for [Mikro.js](https://mikrojs.dev): a portable fetch handler
implementing the [OTA Registry Spec](https://mikrojs.dev/registry-spec). Publish builds with
`mikro ota push`, enroll devices with `mikro ota enroll`, and serve update offers and
per-device config to the `mikro/ota` check-in flow, on Node, Bun, Deno, Cloudflare Workers,
or behind any framework that speaks fetch.

> **Scope.** This is built for a private network or a small hobby fleet: a few devices, one
> operator, a box you control. It is not built for scale or for serving strangers, and it
> leaves out much of what that would need — rate limiting that survives a reverse proxy,
> per-caller quotas, storage sturdier than flat files, backups, secret rotation, and any
> notion of tenants or orgs. Past that, build your own against the same spec; the `storage`,
> `verifyAdmin`, and `verifyDevice` seams are there for it.
>
> Whatever the scale, the admin token is publish and enrol for the whole fleet, and holding
> it means running code on every device. Generate one rather than choosing one, and put the
> registry behind TLS if it is reachable from anywhere you do not control.

```js
import {createRegistry, memoryStorage} from '@mikrojs/registry'

const registry = createRegistry({storage: memoryStorage(), token: 'choose-a-secret'})
// registry.fetch(request) => Promise<Response>
```

On Node, `@mikrojs/registry/node` adds file-backed storage and a plain `node:http` server:

```js
import {createRegistry} from '@mikrojs/registry'
import {fileStorage, serve} from '@mikrojs/registry/node'

serve(createRegistry({storage: fileStorage('./data'), token: 'choose-a-secret'}), {port: 4873})
```

Both `storage` (a small interface over build blobs, build and channel records, device
records, config schemas, and issued tokens) and auth (`verifyAdmin`, `verifyDevice`) are
pluggable, so the same handler runs against whatever backend you already operate. See
`examples/ota` in the repo (its `registry/server.ts`) for a runnable walkthrough with a real
device.

Build downloads are authenticated: the endpoint takes a device update key, and it serves a
build only to a device enrolled under that build's app. A checksum is not a credential, so
one recovered from a device's flash reads nothing on its own, and rotating a device's update
key cuts off the old key here as well.

## Browser login

With `token` auth, the registry also serves the spec's optional browser-login flow: a
client `POST`s `/api/v1/auth/sessions` (optionally with `{app}` context), sends the user to
the returned `loginUrl` to type the returned `userCode` there, and polls for the result. The
code is what ties the browser back to the client that asked, so a login someone else started
is not the one you approve. The approve page authenticates with the registry password (the
`token` option), typed once in the browser, and issues a `tok_...` scoped to publishing that
app plus enrolling devices. Workstations then hold scoped tokens; the password itself never
leaves the operator. Registries using `verifyAdmin` answer 404 there (the spec's "not
supported" signal) and wire their own login.
