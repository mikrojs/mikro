import {createHash} from 'node:crypto'

import {createRegistry, memoryStorage} from '@mikrojs/registry'
import {describe, expect, it, vi} from 'vitest'

import {parseOffer} from '../../runtime/ota/policy.js'

// The two halves of the check-in protocol meet on the wire: the reference
// registry (`@mikrojs/registry`, `handleCheckin`) assembles a response, and the
// device (`parseOffer` here, `examples/ota/app/updates.ts` around it) reads it.
// A field the registry stops sending, or a body shape the client reads wrong,
// is invisible to either side's own unit tests — both stay green while the wire
// between them breaks. This drives a real POST through the registry and hands
// its actual JSON response to the real client parser, so the two contracts are
// checked against each other rather than each against a fixture.

const TOKEN = 'tok_seam'
const BASE = 'https://updates.test'

function build(content: string) {
  const bytes = new TextEncoder().encode(content)
  return {bytes, checksum: createHash('sha256').update(bytes).digest('hex')}
}

async function publish(
  registry: {fetch(r: Request): Promise<Response>},
  content: string,
  overrides: Record<string, string> = {},
) {
  const {bytes, checksum} = build(content)
  const form = new FormData()
  form.set('app', overrides.app ?? 'sensor')
  form.set('version', overrides.version ?? '1.0.0')
  form.set('checksum', checksum)
  form.set('size', String(bytes.byteLength))
  form.set('firmwareVersion', overrides.firmwareVersion ?? '1.0.0')
  form.set('bytecodeVersion', overrides.bytecodeVersion ?? '13')
  // A stored build is served to no device until a channel points at it. These
  // tests assert the check-in offer, so they publish straight to the default
  // channel with the `channel` field (the wire form of `push --release main`).
  form.set('channel', overrides.channel ?? 'main')
  form.set('build', new Blob([bytes], {type: 'application/gzip'}), 'app.tgz')
  const res = await registry.fetch(
    new Request(`${BASE}/api/v1/builds`, {
      method: 'POST',
      headers: {authorization: `Bearer ${TOKEN}`},
      body: form,
    }),
  )
  expect(res.status).toBe(201)
  return {bytes, checksum}
}

async function enroll(registry: {fetch(r: Request): Promise<Response>}) {
  const res = await registry.fetch(
    new Request(`${BASE}/api/v1/devices`, {
      method: 'POST',
      headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
      body: JSON.stringify({deviceId: 'dev-1', app: 'sensor'}),
    }),
  )
  expect(res.status).toBe(201)
  return ((await res.json()) as {credential: string}).credential
}

/** A check-in body shaped exactly as `examples/ota/app/updates.ts` sends it. */
function checkin(
  registry: {fetch(r: Request): Promise<Response>},
  credential: string,
  body: Record<string, unknown> = {},
) {
  return registry.fetch(
    new Request(`${BASE}/api/v1/checkin`, {
      method: 'POST',
      headers: {authorization: `Bearer ${credential}`, 'content-type': 'application/json'},
      body: JSON.stringify({
        deviceId: 'dev-1',
        firmware: '1.0.0',
        firmwareHash: 'abc',
        bytecode: 13,
        running: {trial: false},
        name: [0],
        free: 1_000_000,
        ...body,
      }),
    }),
  )
}

describe('check-in ⇄ parseOffer seam', () => {
  it('an offer the registry sends parses into a usable Offer on the device', async () => {
    const registry = createRegistry({storage: memoryStorage(), token: TOKEN})
    const {checksum, bytes} = await publish(registry, 'a-real-build')
    const credential = await enroll(registry)

    // The registry's actual response body, not a hand-built fixture.
    const body = await (await checkin(registry, credential)).json()
    const offer = parseOffer(body)

    // The whole point: the fields the registry sends are exactly the ones the
    // client needs, and nothing in between drops or renames one.
    expect(offer).toBeDefined()
    expect(offer!.checksum).toBe(checksum)
    expect(offer!.size).toBe(bytes.byteLength)
    expect(offer!.url).toBe(`${BASE}/api/v1/builds/${checksum}.tgz`)
  })

  it('a no-update response reads as "no offer", not a malformed one', async () => {
    const registry = createRegistry({storage: memoryStorage(), token: TOKEN})
    const {checksum} = await publish(registry, 'a-real-build')
    const credential = await enroll(registry)

    // Already running the current build: the registry answers with no offer.
    const body = await (
      await checkin(registry, credential, {running: {checksum, trial: false}})
    ).json()
    expect(parseOffer(body)).toBeUndefined()
  })

  it('a name-only response is "no offer", not a warned-about malformed one', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const {checksum} = await publish(registry, 'a-real-build')
    const credential = await enroll(registry)

    // A dashboard rename with nothing newer to install: the registry sends back
    // the name and no offer fields. That shape must parse quietly to "no offer"
    // and warn for nothing, or every rename that coincides with "up to date"
    // logs a misleading warning on the device.
    const device = (await storage.getDevice('dev-1'))!
    await storage.putDevice({...device, name: 'kitchen', nameRev: 3})

    const body = (await (
      await checkin(registry, credential, {running: {checksum, trial: false}, name: [0]})
    ).json()) as {name?: unknown; url?: unknown}
    expect(body.name).toEqual([3, 'kitchen'])
    expect(body.url).toBeUndefined()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseOffer(body)).toBeUndefined()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('accepts an offer whose download url is on another host', async () => {
    // A registry may serve builds from a CDN or object store on a different
    // host, or hand out a signed url. parseOffer trusts the url the registry
    // named (the check-in is authenticated) and does not pin it to the registry
    // origin; integrity is the checksum, and the credential is confined by the
    // caller. Stand in for that by rewriting the offer url onto another host.
    const registry = createRegistry({storage: memoryStorage(), token: TOKEN})
    const {checksum} = await publish(registry, 'a-real-build')
    const credential = await enroll(registry)
    const body = (await (await checkin(registry, credential)).json()) as {url: string}
    body.url = `https://cdn.elsewhere.example/${checksum}.tgz`

    const offer = parseOffer(body)
    expect(offer?.url).toBe(`https://cdn.elsewhere.example/${checksum}.tgz`)
    expect(offer?.checksum).toBe(checksum)
  })

  it('a registry-side rename round-trips through the check-in body', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    await publish(registry, 'a-real-build')
    const credential = await enroll(registry)

    // Rename on the registry to revision 3, standing in for a dashboard edit.
    const device = (await storage.getDevice('dev-1'))!
    await storage.putDevice({...device, name: 'kitchen', nameRev: 3})

    // The device checks in at revision 0; the registry sends its newer pair back
    // in the same response shape the client's adoptName() reads.
    const body = (await (await checkin(registry, credential, {name: [0]})).json()) as {
      name?: [number, string?]
    }
    expect(body.name).toEqual([3, 'kitchen'])
  })
})
