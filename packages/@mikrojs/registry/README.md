# @mikrojs/registry

Reference OTA update registry for [Mikro.js](https://mikrojs.dev): a portable fetch handler
implementing the [OTA Registry Spec](https://mikrojs.dev/registry-spec). Publish builds with
`mikro ota publish`, enroll devices with `mikro ota enroll`, and serve update offers to the
`mikro/ota` check-in flow, on Node, Bun, Deno, Cloudflare Workers, or behind any framework
that speaks fetch.

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

Both `storage` (a small interface over build blobs, device records, and minted tokens) and
auth (`verifyAdmin`, `verifyDevice`) are pluggable, so the same handler runs against
whatever backend you already operate. See `examples/ota` in the repo (its
`registry/server.ts`) for a runnable walkthrough with a real device.

Build downloads are capability URLs: the 256-bit checksum is the credential, and the
endpoint takes no auth. A checksum recovered from a device's flash therefore grants
access to that build indefinitely, including after the device's credential is re-minted.
Serve builds behind your own auth if that matters for your app.

## Browser login

With `token` auth, the registry also serves the spec's optional browser-login flow: a
client `POST`s `/api/v1/auth/sessions` (optionally with `{app}` context), sends the user to
the returned `loginUrl`, and polls for the result. The approve page authenticates with the
registry password (the `token` option), typed once in the browser, and mints a `tok_...`
scoped to publishing that app plus enrolling devices. Workstations then hold scoped minted
tokens; the password itself never leaves the operator. Registries using `verifyAdmin` answer
404 there (the spec's "not supported" signal) and wire their own login.
