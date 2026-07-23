import {createHash} from 'node:crypto'

import {describe, expect, it, vi} from 'vitest'

import {memoryStorage} from '../memoryStorage.js'
import {createRegistry} from '../registry.js'
import type {Registry, RegistryStorage} from '../types.js'

const TOKEN = 'tok_test'
const BASE = 'https://updates.test'

function makeRegistry(): Registry {
  return createRegistry({storage: memoryStorage(), token: TOKEN})
}

function buildBytes(content: string): {bytes: Uint8Array; checksum: string} {
  const bytes = new TextEncoder().encode(content)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  return {bytes, checksum}
}

async function publish(
  registry: Registry,
  overrides: Partial<Record<string, string>> = {},
  content = 'fake-tgz-bytes',
): Promise<{response: Response; checksum: string}> {
  const {bytes, checksum} = buildBytes(content)
  const form = new FormData()
  form.set('app', overrides.app ?? 'sensor')
  form.set('version', overrides.version ?? '1.0.0')
  form.set('checksum', overrides.checksum ?? checksum)
  form.set('size', overrides.size ?? String(bytes.byteLength))
  form.set('firmwareVersion', overrides.firmwareVersion ?? '0.15.0')
  form.set('bytecodeVersion', overrides.bytecodeVersion ?? '13')
  if (overrides.note !== undefined) form.set('note', overrides.note)
  // Publish now serves nothing on its own; a `channel` field is what points a
  // channel at the build. Default to `main` so the pre-channels tests keep
  // getting an immediate offer; pass `channel: ''` for a bare store-only push.
  const channel = overrides.channel ?? 'main'
  if (channel !== '') form.set('channel', channel)
  form.set('build', new Blob([bytes], {type: 'application/gzip'}), 'app.tgz')
  const response = await registry.fetch(
    new Request(`${BASE}/api/v1/builds`, {
      method: 'POST',
      headers: {authorization: `Bearer ${overrides.token ?? TOKEN}`},
      body: form,
    }),
  )
  return {response, checksum: overrides.checksum ?? checksum}
}

async function enroll(
  registry: Registry,
  deviceId = 'dev-1',
  body: Record<string, unknown> = {},
): Promise<string> {
  const response = await registry.fetch(
    new Request(`${BASE}/api/v1/devices`, {
      method: 'POST',
      headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
      // Enrollment binds the app, so the default matches `publish`'s.
      body: JSON.stringify({deviceId, app: 'sensor', ...body}),
    }),
  )
  expect(response.status).toBe(201)
  const credential = (await response.json()) as {credential: string}
  return credential.credential
}

function checkin(
  registry: Registry,
  credential: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return registry.fetch(
    new Request(`${BASE}/api/v1/checkin`, {
      method: 'POST',
      headers: {authorization: `Bearer ${credential}`, 'content-type': 'application/json'},
      body: JSON.stringify({
        deviceId: 'dev-1',
        firmware: '0.15.0',
        bytecode: 13,
        running: {trial: false},
        ...body,
      }),
    }),
  )
}

describe('publish', () => {
  // Check-in fields are capped and these were not, though they land in the same
  // index — re-serialised on every publish, read on every check-in. That turned
  // a token scoped to one app into a lever on the whole registry's availability.
  it('caps the strings it stores, the way it caps check-in strings', async () => {
    const registry = makeRegistry()
    const huge = 'A'.repeat(100_000)
    for (const field of ['app', 'version', 'firmwareVersion', 'note']) {
      const {response} = await publish(registry, {[field]: huge})
      expect(response.status, `${field} should be rejected`).toBe(400)
      expect(await response.text()).toContain('at most')
    }
  })

  it('stores a build and 401s without the token', async () => {
    const registry = makeRegistry()
    const {response} = await publish(registry)
    expect(response.status).toBe(201)
    const denied = await publish(registry, {token: 'wrong'})
    expect(denied.response.status).toBe(401)
  })

  it('re-publishing an earlier release rolls the fleet back to it', async () => {
    const registry = makeRegistry()
    const {checksum: v1} = await publish(registry, {version: '1.0.0'}, 'build-one')
    const {checksum: v2} = await publish(registry, {version: '2.0.0'}, 'build-two')
    const credential = await enroll(registry, 'dev-1', {app: 'sensor'})
    expect(
      ((await (await checkin(registry, credential)).json()) as {checksum: string}).checksum,
    ).toBe(v2)

    // The spec's downgrade path: publishing an older build is the rollback, so
    // an idempotent re-publish still has to promote it.
    const {response} = await publish(registry, {version: '1.0.0'}, 'build-one')
    expect(response.status).toBe(200)

    const offer = (await (
      await checkin(registry, credential, {
        running: {checksum: v2, trial: false},
      })
    ).json()) as {checksum: string}
    expect(offer.checksum).toBe(v1)
  })

  it('is idempotent for the same release + checksum, 409 for a different checksum', async () => {
    const registry = makeRegistry()
    expect((await publish(registry)).response.status).toBe(201)
    expect((await publish(registry)).response.status).toBe(200)
    const conflict = await publish(registry, {}, 'different-bytes')
    expect(conflict.response.status).toBe(409)
  })

  // Storage is keyed by checksum, so identical bytes under two apps cannot both
  // exist. Silently keeping one strands the other app's devices with no offer
  // and no error; reproducible packing means two apps from the same starter
  // collide before either has written a line of its own code.
  it('409s a build whose bytes are already published under another app', async () => {
    const registry = makeRegistry()
    expect((await publish(registry, {app: 'alpha'}, 'same-bytes')).response.status).toBe(201)
    const collide = await publish(registry, {app: 'beta'}, 'same-bytes')
    expect(collide.response.status).toBe(409)
    expect(await collide.response.text()).toContain('alpha')

    // alpha is untouched: its record survives and its devices still get offers.
    const credential = await enroll(registry, 'dev-1', {app: 'alpha'})
    const offer = (await (await checkin(registry, credential)).json()) as {checksum: string}
    expect(offer.checksum).toBe(collide.checksum)
  })

  it('rejects an upload whose bytes do not match the checksum', async () => {
    const registry = makeRegistry()
    const {checksum} = buildBytes('other-content')
    const {response} = await publish(registry, {checksum})
    expect(response.status).toBe(400)
  })

  it('re-publishing restores a blob whose record outlived it', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const {checksum} = await publish(registry)
    // The record survives its blob when an index is restored from backup or a
    // storage migration half-lands. Re-publishing is what an operator reaches
    // for once downloads 404, so it has to actually put the bytes back.
    const bare = memoryStorage()
    await bare.putBuild((await storage.listBuilds())[0]!)
    const recovered = createRegistry({storage: bare, token: TOKEN})
    // Downloads take a device credential, so the missing blob has to be probed
    // as a device would; an anonymous request 401s before it reaches the blob.
    const auth = {authorization: `Bearer ${await enroll(recovered)}`}
    expect(
      (await recovered.fetch(new Request(`${BASE}/api/v1/builds/${checksum}.tgz`, {headers: auth})))
        .status,
    ).toBe(404)

    expect((await publish(recovered)).response.status).toBe(200)
    const download = await recovered.fetch(
      new Request(`${BASE}/api/v1/builds/${checksum}.tgz`, {headers: auth}),
    )
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('fake-tgz-bytes')
  })
})

describe('release channels', () => {
  /** `POST /api/v1/releases`: point a channel at a version already stored. */
  function release(
    registry: Registry,
    body: {app?: string; version?: string; channel?: string},
    token = TOKEN,
  ): Promise<Response> {
    return registry.fetch(
      new Request(`${BASE}/api/v1/releases`, {
        method: 'POST',
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
        body: JSON.stringify(body),
      }),
    )
  }

  /** Mint an app-scoped token through browser login, the way `grant scope`
   *  does, so a scoped-token case exercises a real record. */
  async function mintScopedToken(registry: Registry, app: string): Promise<string> {
    const session = (await (
      await registry.fetch(
        new Request(`${BASE}/api/v1/auth/sessions`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({app}),
        }),
      )
    ).json()) as {code: string; userCode: string}
    const form = new FormData()
    form.set('userCode', session.userCode)
    form.set('secret', TOKEN)
    await registry.fetch(new Request(`${BASE}/login`, {method: 'POST', body: form}))
    const {token} = (await (
      await registry.fetch(new Request(`${BASE}/api/v1/auth/sessions/${session.code}/token`))
    ).json()) as {token: string}
    return token
  }

  // Publish stores; a channel is what serves. A bare push uploads and returns,
  // and a device following main is offered nothing until the build is released.
  it('stores a bare push but offers it only once released to main', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry, {channel: ''})
    const credential = await enroll(registry)
    expect(await (await checkin(registry, credential)).json()).toBeNull()

    const released = await release(registry, {app: 'sensor', version: '1.0.0', channel: 'main'})
    expect(released.status).toBe(200)
    expect(await released.json()).toEqual({ok: true, released: 1})

    const offer = (await (await checkin(registry, credential)).json()) as {checksum: string}
    expect(offer.checksum).toBe(checksum)
  })

  // The old publish-then-serve behavior, now opt-in with `channel: main`.
  it('publishing straight to main serves immediately', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry, {channel: 'main'})
    const credential = await enroll(registry)
    const offer = (await (await checkin(registry, credential)).json()) as {checksum: string}
    expect(offer.checksum).toBe(checksum)
  })

  // `push --release beta`: a named channel gets a pointer, and the build record
  // stays tag-less, so a device on main is offered nothing.
  it('serves a named-channel build only to devices on that channel', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry, {channel: 'beta'})
    const betaCred = await enroll(registry, 'dev-beta', {app: 'sensor', channel: 'beta'})
    const mainCred = await enroll(registry, 'dev-main', {app: 'sensor'})

    const betaOffer = (await (await checkin(registry, betaCred)).json()) as {checksum: string}
    expect(betaOffer.checksum).toBe(checksum)
    expect(await (await checkin(registry, mainCred)).json()).toBeNull()
  })

  // Graduation: a build proven on beta becomes main's current with a release,
  // no re-upload.
  it('graduates a beta build to main with a release', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry, {channel: 'beta'})
    const mainCred = await enroll(registry)
    expect(await (await checkin(registry, mainCred)).json()).toBeNull()

    const released = await release(registry, {app: 'sensor', version: '1.0.0', channel: 'main'})
    expect(released.status).toBe(200)

    const offer = (await (await checkin(registry, mainCred)).json()) as {checksum: string}
    expect(offer.checksum).toBe(checksum)
  })

  // One version spans a build per bytecode; a single release points the channel
  // at every one, so a fleet on different firmware lines moves together.
  it('points every bytecode of a version at the channel in one release', async () => {
    const registry = makeRegistry()
    const b13 = await publish(registry, {channel: '', bytecodeVersion: '13'}, 'multi-bc13')
    const b14 = await publish(registry, {channel: '', bytecodeVersion: '14'}, 'multi-bc14')

    const released = await release(registry, {app: 'sensor', version: '1.0.0', channel: 'beta'})
    expect(await released.json()).toEqual({ok: true, released: 2})

    const cred13 = await enroll(registry, 'dev-13', {app: 'sensor', channel: 'beta'})
    const cred14 = await enroll(registry, 'dev-14', {app: 'sensor', channel: 'beta'})
    const offer13 = (await (await checkin(registry, cred13, {bytecode: 13})).json()) as {
      checksum: string
    }
    const offer14 = (await (await checkin(registry, cred14, {bytecode: 14})).json()) as {
      checksum: string
    }
    expect(offer13.checksum).toBe(b13.checksum)
    expect(offer14.checksum).toBe(b14.checksum)
  })

  // Rollback and graduation are the same operation: releasing an older version
  // to a channel makes it current again.
  it('rolls a channel back by releasing an older version', async () => {
    const registry = makeRegistry()
    const v1 = await publish(registry, {channel: '', version: '1.0.0'}, 'roll-v1')
    const v2 = await publish(registry, {channel: '', version: '2.0.0'}, 'roll-v2')

    await release(registry, {app: 'sensor', version: '2.0.0', channel: 'beta'})
    const credential = await enroll(registry, 'dev-beta', {app: 'sensor', channel: 'beta'})
    expect(
      ((await (await checkin(registry, credential)).json()) as {checksum: string}).checksum,
    ).toBe(v2.checksum)

    await release(registry, {app: 'sensor', version: '1.0.0', channel: 'beta'})
    const offer = (await (
      await checkin(registry, credential, {running: {checksum: v2.checksum, trial: false}})
    ).json()) as {checksum: string}
    expect(offer.checksum).toBe(v1.checksum)
  })

  // A named channel is stored on the device record; main (the default, and an
  // explicit `main`) leaves no field, so pre-channels devices need no migration.
  it('stores a named enroll channel and treats absent (and main) as main', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const {checksum} = await publish(registry, {channel: 'main'})
    const betaCred = await enroll(registry, 'dev-beta', {app: 'sensor', channel: 'beta'})
    const mainCred = await enroll(registry, 'dev-main', {app: 'sensor'})
    await enroll(registry, 'dev-explicit', {app: 'sensor', channel: 'main'})

    expect((await storage.getDevice('dev-beta'))!.channel).toBe('beta')
    expect((await storage.getDevice('dev-main'))!.channel).toBeUndefined()
    expect((await storage.getDevice('dev-explicit'))!.channel).toBeUndefined()

    // The channel-absent device follows main and is offered the main build.
    expect(
      ((await (await checkin(registry, mainCred)).json()) as {checksum: string}).checksum,
    ).toBe(checksum)
    // The beta device follows beta, which nothing has been released to.
    expect(await (await checkin(registry, betaCred)).json()).toBeNull()
  })

  it('rejects an invalid channel name on publish, release, and enroll', async () => {
    const registry = makeRegistry()

    expect((await publish(registry, {channel: 'has space'})).response.status).toBe(400)
    expect((await publish(registry, {channel: 'c'.repeat(65)})).response.status).toBe(400)

    // Channel validity is checked before the build lookup, so a stored build is
    // not needed to reach it.
    expect(
      (await release(registry, {app: 'sensor', version: '1.0.0', channel: 'bad/slash'})).status,
    ).toBe(400)
    expect(
      (await release(registry, {app: 'sensor', version: '1.0.0', channel: 'c'.repeat(65)})).status,
    ).toBe(400)

    const enrolled = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {
        method: 'POST',
        headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
        body: JSON.stringify({deviceId: 'dev-x', app: 'sensor', channel: 'bad channel'}),
      }),
    )
    expect(enrolled.status).toBe(400)
  })

  it('404s releasing a version that was never published', async () => {
    const registry = makeRegistry()
    await publish(registry, {channel: '', version: '1.0.0'})
    const missing = await release(registry, {app: 'sensor', version: '9.9.9', channel: 'beta'})
    expect(missing.status).toBe(404)
  })

  it('403s an app-scoped token releasing another app', async () => {
    const registry = makeRegistry()
    await publish(registry, {channel: '', app: 'display', version: '1.0.0'}, 'display-bytes')
    const token = await mintScopedToken(registry, 'sensor')
    const denied = await release(
      registry,
      {app: 'display', version: '1.0.0', channel: 'beta'},
      token,
    )
    expect(denied.status).toBe(403)
  })
})

describe('bearer auth rate limiting', () => {
  // The admin secret is operator-chosen and grants publish and enroll for the
  // whole fleet. The approve page has had per-address backoff all along; the API
  // guarding the same secret had none, so it could be guessed at line rate.
  it('backs off a run of wrong bearers from one address', async () => {
    const registry = makeRegistry()
    const wrong = (n: number) =>
      registry.fetch(
        new Request(`${BASE}/api/v1/devices`, {
          headers: {authorization: `Bearer guess-${n}`, 'mikro-client-ip': '10.0.0.9'},
        }),
      )
    for (let i = 0; i < 4; i++) expect((await wrong(i)).status).toBe(401)

    // Backed off: the correct secret from that address is refused too, which is
    // the point — the limiter cannot be probed around by getting it right.
    const correct = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {
        headers: {authorization: `Bearer ${TOKEN}`, 'mikro-client-ip': '10.0.0.9'},
      }),
    )
    expect(correct.status).toBe(401)

    // A different address is unaffected.
    const elsewhere = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {
        headers: {authorization: `Bearer ${TOKEN}`, 'mikro-client-ip': '10.0.0.10'},
      }),
    )
    expect(elsewhere.status).toBe(200)
  })

  it('does not penalise a caller who keeps authenticating correctly', async () => {
    const registry = makeRegistry()
    for (let i = 0; i < 20; i++) {
      const res = await registry.fetch(
        new Request(`${BASE}/api/v1/devices`, {
          headers: {authorization: `Bearer ${TOKEN}`, 'mikro-client-ip': '10.0.0.11'},
        }),
      )
      expect(res.status).toBe(200)
    }
  })

  // The throttle is on the guessable static secret only. A minted token is
  // unguessable and looked up in O(1), so it authenticates even from an address
  // someone else has backed off guessing the secret — otherwise junk bearers
  // would 401 every operator, which is a token holder.
  it('a valid token still authenticates from a backed-off address', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const token = 'tok_operator_secret'
    await storage.putToken({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })

    // An attacker backs off 10.0.0.30 guessing the static secret.
    for (let i = 0; i < 5; i++) {
      await registry.fetch(
        new Request(`${BASE}/api/v1/devices`, {
          headers: {authorization: `Bearer wrong-${i}`, 'mikro-client-ip': '10.0.0.30'},
        }),
      )
    }
    // The static secret from that address is now refused...
    expect(
      (
        await registry.fetch(
          new Request(`${BASE}/api/v1/devices`, {
            headers: {authorization: `Bearer ${TOKEN}`, 'mikro-client-ip': '10.0.0.30'},
          }),
        )
      ).status,
    ).toBe(401)
    // ...but a real token from the same address is not.
    expect(
      (
        await registry.fetch(
          new Request(`${BASE}/api/v1/devices`, {
            headers: {authorization: `Bearer ${token}`, 'mikro-client-ip': '10.0.0.30'},
          }),
        )
      ).status,
    ).toBe(200)
  })
})

describe('enroll + re-mint', () => {
  it('mints a credential once and 409s on a second enroll', async () => {
    const registry = makeRegistry()
    const credential = await enroll(registry)
    expect(credential).toMatch(/^dvc_/)
    const again = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {
        method: 'POST',
        headers: {authorization: `Bearer ${TOKEN}`},
        body: JSON.stringify({deviceId: 'dev-1'}),
      }),
    )
    expect(again.status).toBe(409)
  })

  it('re-mint invalidates the old credential immediately', async () => {
    const registry = makeRegistry()
    const old = await enroll(registry)
    const remint = await registry.fetch(
      new Request(`${BASE}/api/v1/devices/dev-1/credential`, {
        method: 'POST',
        headers: {authorization: `Bearer ${TOKEN}`},
      }),
    )
    expect(remint.status).toBe(200)
    const {credential: fresh} = (await remint.json()) as {credential: string}

    expect((await checkin(registry, old)).status).toBe(401)
    expect((await checkin(registry, fresh)).status).toBe(200)
  })

  it('never exposes the credential hash in device views', async () => {
    const registry = makeRegistry()
    await enroll(registry)
    const list = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {headers: {authorization: `Bearer ${TOKEN}`}}),
    )
    const body = (await list.json()) as {devices: Record<string, unknown>[]}
    expect(body.devices[0]!.deviceId).toBe('dev-1')
    expect(body.devices[0]!.credentialHash).toBeUndefined()
  })
})

describe('check-in', () => {
  it('401s without a known credential', async () => {
    const registry = makeRegistry()
    expect((await checkin(registry, 'dvc_unknown')).status).toBe(401)
  })

  it('offers the current build with a download url, then nothing once running it', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry)
    const credential = await enroll(registry)

    const first = await checkin(registry, credential)
    const offer = (await first.json()) as {url: string; checksum: string; version: string}
    expect(offer.checksum).toBe(checksum)
    expect(offer.version).toBe('1.0.0')
    expect(offer.url).toBe(`${BASE}/api/v1/builds/${checksum}.tgz`)

    const second = await checkin(registry, credential, {running: {checksum, trial: false}})
    expect(await second.json()).toBeNull()
  })

  // The device no longer checks this, so the registry is the only gate. Caret
  // semantics: at or above the build's firmware, within its breaking boundary —
  // the major for 1.x, the minor for 0.x.
  it("offers within the build's major, at or above its firmware version", async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry, {firmwareVersion: '1.3.0'})
    const credential = await enroll(registry, 'dev-1')
    const send = async (firmware: string) =>
      (await (await checkin(registry, credential, {firmware})).json()) as {checksum?: string} | null

    // Below the build's own version: it may use APIs that firmware lacks.
    expect(await send('1.2.0')).toBeNull()
    expect(await send('1.2.9')).toBeNull()
    // At or above, same major: the build was compiled against this API.
    expect((await send('1.3.0'))?.checksum).toBe(checksum)
    expect((await send('1.9.9'))?.checksum).toBe(checksum)
    // A major bump is where the breaking changes are, and bytecodeVersion does
    // not catch them: it tracks the engine, so removing a `mikro/*` API without
    // touching QuickJS leaves it matching.
    expect(await send('2.0.0')).toBeNull()
  })

  // During 0.x semver makes the minor the breaking boundary, so the gate has to
  // as well. A plain "same major" is inert here — every 0.x shares major 0 — and
  // that is the release line the project is actually on.
  it('treats the minor as the boundary for a 0.x build', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry, {firmwareVersion: '0.16.0'})
    const credential = await enroll(registry, 'dev-1')
    const send = async (firmware: string) =>
      (await (await checkin(registry, credential, {firmware})).json()) as {checksum?: string} | null

    expect(await send('0.15.9')).toBeNull()
    expect((await send('0.16.0'))?.checksum).toBe(checksum)
    expect((await send('0.16.5'))?.checksum).toBe(checksum)
    // A 0.x minor bump is a breaking change: the build is not offered across it.
    expect(await send('0.17.0')).toBeNull()
  })

  // Unparseable stops the gate opening rather than widening it. Publish rejects
  // these, so this only guards a record written before that validation existed.
  it('withholds rather than offers when the reported firmware is not a version', async () => {
    const registry = makeRegistry()
    await publish(registry, {firmwareVersion: '1.3.0'})
    const credential = await enroll(registry, 'dev-1')
    expect(await (await checkin(registry, credential, {firmware: 'banana'})).json()).toBeNull()
  })

  // The offer says what to fetch and how to verify it. The fields the registry
  // selected on are not sent: the device cannot act on them, since choosing a
  // different build needs the set the registry holds.
  it('does not send compatibility fields the device cannot act on', async () => {
    const registry = makeRegistry()
    await publish(registry)
    const credential = await enroll(registry, 'dev-1')
    const offer = (await (await checkin(registry, credential)).json()) as Record<string, unknown>
    expect(Object.keys(offer).sort()).toEqual(['checksum', 'size', 'url', 'version'])
  })

  it('withholds offers on bytecode mismatch and unmet firmwareVersion', async () => {
    const registry = makeRegistry()
    await publish(registry, {firmwareVersion: '0.99.0'})
    const credential = await enroll(registry)
    expect(await (await checkin(registry, credential)).json()).toBeNull()

    const registry2 = makeRegistry()
    await publish(registry2)
    const credential2 = await enroll(registry2)
    expect(await (await checkin(registry2, credential2, {bytecode: 14})).json()).toBeNull()
  })

  it('withholds a build the device has no room to stage', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry)
    const size = 'fake-tgz-bytes'.length
    const credential = await enroll(registry)

    // One byte short is short.
    expect(await (await checkin(registry, credential, {free: size - 1})).json()).toBeNull()
    // Exactly enough fits.
    const fits = (await (await checkin(registry, credential, {free: size})).json()) as {
      checksum: string
    }
    expect(fits.checksum).toBe(checksum)
  })

  it('gates on the most recent free report, and not at all before the first', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry)
    const size = 'fake-tgz-bytes'.length
    const credential = await enroll(registry)

    // Never reported: not size-gated, since the device may not speak this
    // protocol at all.
    const ungated = (await (await checkin(registry, credential)).json()) as {checksum: string}
    expect(ungated.checksum).toBe(checksum)

    // Reported once, too small: withheld.
    expect(await (await checkin(registry, credential, {free: 1})).json()).toBeNull()
    // Omitted on the next check-in: the last report stands rather than
    // clearing, so the gate keeps using it.
    expect(await (await checkin(registry, credential)).json()).toBeNull()
    // Freed up: offered again.
    const after = (await (await checkin(registry, credential, {free: size})).json()) as {
      checksum: string
    }
    expect(after.checksum).toBe(checksum)
  })

  it('400s a malformed free rather than storing or dropping it', async () => {
    const registry = makeRegistry()
    await publish(registry)
    const credential = await enroll(registry)
    for (const free of [-1, 1.5, '1024', null]) {
      const response = await checkin(registry, credential, {free})
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({error: 'Invalid free'})
    }
  })

  it('never re-offers a checksum the device reported failing', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry)
    const credential = await enroll(registry)

    const offered = (await (await checkin(registry, credential)).json()) as {checksum: string}
    expect(offered.checksum).toBe(checksum)

    const afterFailure = await checkin(registry, credential, {
      lastInstall: {reason: 'trial-reverted'},
    })
    expect(await afterFailure.json()).toBeNull()
  })

  it('with several apps, follows the binding rather than what it runs', async () => {
    const registry = makeRegistry()
    await publish(registry, {app: 'sensor', version: '1.0.0'}, 'sensor-1')
    const displayV1 = await publish(registry, {app: 'display', version: '1.0.0'}, 'display-1')
    const sensorV2 = await publish(registry, {app: 'sensor', version: '1.1.0'}, 'sensor-2')
    const credential = await enroll(registry, 'dev-1', {app: 'sensor'})

    // Reporting display's build does not move the device onto display.
    const offer = (await (
      await checkin(registry, credential, {
        running: {checksum: displayV1.checksum, trial: false},
      })
    ).json()) as {checksum: string}
    expect(offer.checksum).toBe(sensorV2.checksum)
  })
})

describe('browser login', () => {
  /** Mirrors APPROVE_IP_FREE_ATTEMPTS in registry.ts. */
  const IP_FREE_ATTEMPTS = 3
  /** Mirrors APPROVE_GLOBAL_FREE_ATTEMPTS in registry.ts. */
  const GLOBAL_FREE_ATTEMPTS = 30

  async function startLogin(
    registry: Registry,
    app?: string,
  ): Promise<{loginUrl: string; code: string; userCode: string}> {
    const response = await registry.fetch(
      new Request(`${BASE}/api/v1/auth/sessions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(app === undefined ? {} : {app}),
      }),
    )
    expect(response.status).toBe(201)
    return (await response.json()) as {loginUrl: string; code: string; userCode: string}
  }

  function formOf(fields: Record<string, string>): FormData {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.set(k, v)
    return form
  }

  // This endpoint is unauthenticated, so the global cap on its own is a lockout
  // lever rather than a defence: one address filling every slot holds every
  // legitimate `mikro ota setup` at 429 for the session lifetime.
  it('bounds pending logins per address before the global cap', async () => {
    const registry = makeRegistry()
    const open = (ip: string) =>
      registry.fetch(
        new Request(`${BASE}/api/v1/auth/sessions`, {
          method: 'POST',
          headers: {'content-type': 'application/json', 'mikro-client-ip': ip},
          body: '{}',
        }),
      )

    for (let i = 0; i < 5; i++) expect((await open('10.0.0.9')).status).toBe(201)
    const blocked = await open('10.0.0.9')
    expect(blocked.status).toBe(429)
    expect(await blocked.text()).toContain('from this address')

    // The point of the bound: another operator is unaffected.
    expect((await open('10.0.0.10')).status).toBe(201)
  })

  // Sequential admission is the easy half. The cap has to hold against a burst
  // too: reading the body is asynchronous, so a check that admits before the
  // session exists lets every concurrent caller through at once and the bound
  // above constrains round trips rather than sessions.
  it('bounds pending logins per address against a concurrent burst', async () => {
    const registry = makeRegistry()
    const open = () =>
      registry.fetch(
        new Request(`${BASE}/api/v1/auth/sessions`, {
          method: 'POST',
          headers: {'content-type': 'application/json', 'mikro-client-ip': '10.0.0.11'},
          body: '{}',
        }),
      )

    const responses = await Promise.all(Array.from({length: 200}, open))
    const created = responses.filter((r) => r.status === 201).length
    expect(created).toBe(5)
    expect(responses.filter((r) => r.status === 429).length).toBe(195)
  })

  /** Approve in one post. The page does this in two steps (code, then
   *  password), but the handler accepts both together, which is what the
   *  confirm form submits. */
  function approve(
    registry: Registry,
    userCode: string,
    secret = TOKEN,
    ip = '10.0.0.1',
  ): Promise<Response> {
    const form = new FormData()
    form.set('userCode', userCode)
    form.set('secret', secret)
    return registry.fetch(
      new Request(`${BASE}/login`, {
        method: 'POST',
        headers: {'mikro-client-ip': ip},
        body: form,
      }),
    )
  }

  async function claim(registry: Registry, code: string): Promise<Response> {
    return registry.fetch(new Request(`${BASE}/api/v1/auth/sessions/${code}/token`))
  }

  it('mints a token via approve, hands it out exactly once', async () => {
    const registry = makeRegistry()
    const {loginUrl, code, userCode} = await startLogin(registry, 'sensor')
    // The url is constant and carries no session at all: neither the claim
    // capability nor the code the operator types appears in it.
    expect(loginUrl).toBe(`${BASE}/login`)
    expect(loginUrl).not.toContain(code)
    expect(loginUrl).not.toContain(userCode)

    // Pending until the browser approves.
    expect((await claim(registry, code)).status).toBe(202)

    // Landing on the url discloses nothing: with no session in it, the page
    // cannot say which app a CLI is trying to authorize, only ask for the code.
    const page = await registry.fetch(new Request(loginUrl))
    expect(page.status).toBe(200)
    expect(await page.text()).not.toContain('sensor')

    // Step 1, the code alone: now the page can say what is being approved.
    const confirm = await registry.fetch(
      new Request(`${BASE}/login`, {method: 'POST', body: formOf({userCode})}),
    )
    expect(confirm.status).toBe(200)
    expect(await confirm.text()).toContain('sensor')

    // Step 2, code + password.
    expect((await approve(registry, userCode)).status).toBe(200)

    const claimed = await claim(registry, code)
    expect(claimed.status).toBe(200)
    const {token} = (await claimed.json()) as {token: string}
    expect(token).toMatch(/^tok_/)
    expect(claimed.headers.get('cache-control')).toBe('no-store')

    // The session is discarded with the token: a second claim finds nothing.
    expect((await claim(registry, code)).status).toBe(404)
  })

  it('mints distinct user codes, since the code is now the lookup key', async () => {
    const registry = makeRegistry()
    const seen = new Set<string>()
    for (let i = 0; i < 25; i++) seen.add((await startLogin(registry)).userCode)
    expect(seen.size).toBe(25)
  })

  it('caps live sessions, since creating one is unauthenticated', async () => {
    const registry = makeRegistry()
    const start = () =>
      registry.fetch(new Request(`${BASE}/api/v1/auth/sessions`, {method: 'POST', body: '{}'}))
    for (let i = 0; i < 500; i++) expect((await start()).status).toBe(201)
    const capped = await start()
    expect(capped.status).toBe(429)
    expect(capped.headers.get('retry-after')).toBe('60')
  })

  it('rate-limits guessing the code, not just the password', async () => {
    const registry = makeRegistry()
    await startLogin(registry)
    // Step 1 posts a bare code. A wrong one has to count as an attempt, or the
    // code is a free oracle for finding live sessions.
    const guess = () =>
      registry.fetch(
        new Request(`${BASE}/login`, {
          method: 'POST',
          headers: {'mikro-client-ip': '10.0.0.77'},
          body: formOf({userCode: 'BCDF-GHJK'}),
        }),
      )
    for (let i = 0; i < 4; i++) expect((await guess()).status).toBe(401)
    expect((await guess()).status).toBe(429)
  })

  it('rejects a wrong secret and unknown codes', async () => {
    const registry = makeRegistry()
    const {code, userCode} = await startLogin(registry)
    expect((await approve(registry, userCode, 'wrong')).status).toBe(401)
    expect((await claim(registry, code)).status).toBe(202)
    expect((await claim(registry, 'nope')).status).toBe(404)
  })

  it('refuses to approve without the user code the CLI displayed', async () => {
    const registry = makeRegistry()
    // The attacker holds the whole session response and forwards `loginUrl`,
    // but only the CLI that started the session shows `userCode`.
    const {code, userCode} = await startLogin(registry)

    const page = await registry.fetch(new Request(`${BASE}/login`))
    const pageText = await page.text()
    expect(pageText).toContain('name="userCode"')
    // The page must not carry the answer: the operator has to type it.
    expect(pageText).not.toContain(userCode)
    expect(page.headers.get('cache-control')).toBe('no-store')

    // Right password, no code: still refused, and no token is minted.
    expect((await approve(registry, '')).status).toBe(401)
    expect((await approve(registry, 'BCDF-GHJK')).status).toBe(401)
    expect((await claim(registry, code)).status).toBe(202)

    // The same code the CLI printed, retyped in lowercase and without the
    // separator, approves.
    const typed = userCode.toLowerCase().replace('-', ' ')
    expect((await approve(registry, typed)).status).toBe(200)
    expect((await claim(registry, code)).status).toBe(200)
  })

  it('backs off per address after repeated failed approvals', async () => {
    const registry = makeRegistry()
    const {userCode} = await startLogin(registry)

    // Three free attempts, then each further failure arms a backoff.
    for (let i = 0; i < 4; i++) {
      expect((await approve(registry, userCode, 'wrong', '10.0.0.9')).status).toBe(401)
    }
    const blocked = await approve(registry, userCode, 'wrong', '10.0.0.9')
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)

    // Correct credentials from that address are refused while it is backing off.
    expect((await approve(registry, userCode, TOKEN, '10.0.0.9')).status).toBe(429)
    // Another address still has its own free attempts.
    expect((await approve(registry, userCode, TOKEN, '10.0.0.10')).status).toBe(200)
  })

  it('keeps backing off when the confirm step is replayed between guesses', async () => {
    const registry = makeRegistry()
    // Starting a session is unauthenticated, so an attacker holds a code they
    // know is good. Reaching the confirm page with it must not buy back the
    // free attempts, or the per-address backoff never engages.
    const {userCode} = await startLogin(registry)
    const ip = '10.0.0.66'
    const confirmStep = () =>
      registry.fetch(
        new Request(`${BASE}/login`, {
          method: 'POST',
          headers: {'mikro-client-ip': ip},
          body: formOf({userCode}),
        }),
      )

    for (let i = 0; i < 4; i++) {
      expect((await approve(registry, userCode, `guess-${i}`, ip)).status).toBe(401)
      // The confirm step reserves an attempt and gives that same one back, so
      // replaying it is net zero rather than a reset.
      if (i < 3) expect((await confirmStep()).status).toBe(200)
    }
    expect((await approve(registry, userCode, 'guess-4', ip)).status).toBe(429)
    // The confirm step backs off too, so it cannot be used to probe past it.
    expect((await confirmStep()).status).toBe(429)
  })

  it('rate-limits a concurrent burst, not just sequential guesses', async () => {
    const registry = makeRegistry()
    // Starting a session is unauthenticated, so the attacker holds a live code
    // and only has to guess the password. Every check here runs before an
    // await, so the limiter has to hold against a burst that clears the gate
    // together, not just against sequential guesses.
    const {userCode} = await startLogin(registry)
    const ip = '10.0.0.77'
    const burst = await Promise.all(
      Array.from({length: 200}, (_, i) => approve(registry, userCode, `guess-${i}`, ip)),
    )
    // The free attempts plus the one that trips the backoff, the same as the
    // sequential case admits: 200 concurrent requests buy nothing extra.
    const evaluated = burst.filter((r) => r.status !== 429).length
    expect(evaluated).toBe(IP_FREE_ATTEMPTS + 1)
  })

  it('a burst carrying the real secret still does not mint past the limit', async () => {
    const registry = makeRegistry()
    const {userCode, code} = await startLogin(registry)
    const ip = '10.0.0.78'
    // The correct secret is buried in the burst, after the free attempts are
    // spent; it must be refused like the rest rather than riding through.
    const guesses = [...Array.from({length: 20}, (_, i) => `wrong-${i}`), TOKEN]
    const results = await Promise.all(guesses.map((g) => approve(registry, userCode, g, ip)))
    expect(results.filter((r) => r.status !== 429).length).toBe(IP_FREE_ATTEMPTS + 1)
    // Whether the one real secret happened to land inside the free window is a
    // race; what must hold is that the burst bought no extra chances.
    expect((await claim(registry, code)).status).toBe(results.some((r) => r.ok) ? 200 : 202)
  })

  it('blind guessing from one address cannot lock out a legitimate operator', async () => {
    const registry = makeRegistry()
    // An attacker posts junk codes from their own address until the global
    // bucket is deep into its backoff, which must not answer 429 to everyone
    // else: one unauthenticated request a minute would close login for good.
    for (let i = 0; i < 60; i++) {
      await approve(registry, `ZZZZ-${String(i).padStart(4, '0')}`, 'nope', '10.0.0.99')
    }
    // The operator's password is correct, and a correct password never answers
    // to the global bucket: the only way past it is to already know the secret,
    // so it caps guessing without becoming a lockout lever.
    const {userCode, code} = await startLogin(registry)
    const response = await approve(registry, userCode, TOKEN, '10.0.0.100')
    expect(response.status).toBe(200)
    expect((await claim(registry, code)).status).toBe(200)
  })

  it('caps password guessing behind attacker-minted codes, across rotating addresses', async () => {
    const registry = makeRegistry()
    // Starting a session is unauthenticated, so a live code is not a capability
    // an attacker had to obtain: they mint their own for every guess. Rotating
    // the source address sheds the per-address bucket, so the global bucket is
    // the only thing left standing between a weak password and the fleet.
    let evaluated = 0
    for (let i = 0; i < 300; i++) {
      const {userCode} = await startLogin(registry)
      const response = await approve(registry, userCode, `guess-${i}`, `2001:db8::${i}`)
      if (response.status !== 429) evaluated += 1
    }
    expect(evaluated).toBeLessThanOrEqual(GLOBAL_FREE_ATTEMPTS + 1)
  })

  it('refuses an approve POST a third-party page drove', async () => {
    const registry = makeRegistry()
    const {userCode, code} = await startLogin(registry)
    // Step 1 -> 2 takes no password, so a cross-origin POST would otherwise
    // return the genuine confirm page bound to the attacker's session: the
    // operator would be asked for the registry password without ever typing
    // the code their own terminal displayed.
    for (const headers of [
      {'sec-fetch-site': 'cross-site'},
      {origin: 'https://evil.test'},
      {'sec-fetch-site': 'same-site'},
    ]) {
      const response = await registry.fetch(
        new Request(`${BASE}/login`, {method: 'POST', headers, body: formOf({userCode})}),
      )
      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain('Registry password')
    }
    // The registry's own form still works, and so does a non-browser caller.
    const own = await registry.fetch(
      new Request(`${BASE}/login`, {
        method: 'POST',
        headers: {'sec-fetch-site': 'same-origin', origin: BASE},
        body: formOf({userCode, secret: TOKEN}),
      }),
    )
    expect(own.status).toBe(200)
    expect((await claim(registry, code)).status).toBe(200)
  })

  it('does not share one backoff bucket on hosts that surface no peer address', async () => {
    const registry = makeRegistry()
    const {userCode, code} = await startLogin(registry)
    const noAddress = (secret: string) =>
      registry.fetch(
        new Request(`${BASE}/login`, {method: 'POST', body: formOf({userCode, secret})}),
      )

    // A correct password deliberately does not clear the per-address bucket,
    // so keying every caller under one placeholder would let an anonymous
    // attacker hold login closed for the operator indefinitely.
    for (let i = 0; i < 8; i++) expect((await noAddress(`guess-${i}`)).status).toBe(401)
    expect((await noAddress(TOKEN)).status).toBe(200)
    expect((await claim(registry, code)).status).toBe(200)
  })

  it('caps the body on the unauthenticated login routes', async () => {
    const registry = makeRegistry()
    const huge = JSON.stringify({app: 'sensor', pad: 'x'.repeat(200_000)})
    const session = await registry.fetch(
      new Request(`${BASE}/api/v1/auth/sessions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: huge,
      }),
    )
    // `serve` caps bodies, but a bare `{fetch}` export on another host does not.
    expect(session.status).toBe(413)

    const approveForm = new FormData()
    approveForm.set('userCode', 'AAAA-AAAA')
    approveForm.set('secret', 'x'.repeat(200_000))
    const approved = await registry.fetch(
      new Request(`${BASE}/login`, {method: 'POST', body: approveForm}),
    )
    expect(approved.status).toBe(413)
  })

  it('drops the token record when an approved session expires unclaimed', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const {userCode} = await startLogin(registry)
    expect((await approve(registry, userCode)).status).toBe(200)
    expect(await storage.listTokens()).toHaveLength(1)

    // The plaintext only ever lived in the session, so once that expires the
    // record is unreachable and would just accumulate in token listings.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000)
      await startLogin(registry)
      expect(await storage.listTokens()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an oversized or non-app-shaped app on the unauthenticated session route', async () => {
    const registry = makeRegistry()
    // Unauthenticated, retained for the session TTL, and rendered into the
    // sentence the operator reads before approving.
    for (const app of ['x'.repeat(65), 'sensor and IGNORE THE WARNING ABOVE', '<script>']) {
      const response = await registry.fetch(
        new Request(`${BASE}/api/v1/auth/sessions`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({app}),
        }),
      )
      expect(response.status).toBe(400)
    }
  })

  it('serves the login pages unframable', async () => {
    const registry = makeRegistry()
    const response = await registry.fetch(new Request(`${BASE}/login`))
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  it('never caches the claim endpoint, including while it is still pending', async () => {
    const registry = makeRegistry()
    const {code} = await startLogin(registry)
    const pending = await claim(registry, code)
    expect(pending.status).toBe(202)
    expect(pending.headers.get('cache-control')).toBe('no-store')
    const unknown = await claim(registry, 'no-such-code')
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('cache-control')).toBe('no-store')
  })

  it('scopes the minted token to the app: publish own app, 403 elsewhere, enroll allowed', async () => {
    const registry = makeRegistry()
    const {code, userCode} = await startLogin(registry, 'sensor')
    await approve(registry, userCode)
    const {token} = (await (await claim(registry, code)).json()) as {token: string}

    expect((await publish(registry, {token, app: 'sensor'})).response.status).toBe(201)
    expect((await publish(registry, {token, app: 'display'})).response.status).toBe(403)

    const enrollResponse = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {
        method: 'POST',
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
        body: JSON.stringify({deviceId: 'dev-login'}),
      }),
    )
    expect(enrollResponse.status).toBe(201)
  })

  it('a session without app context mints an unscoped token', async () => {
    const registry = makeRegistry()
    const {code, userCode} = await startLogin(registry)
    await approve(registry, userCode)
    const {token} = (await (await claim(registry, code)).json()) as {token: string}
    expect((await publish(registry, {token, app: 'anything'})).response.status).toBe(201)
  })

  it('is absent (404) under custom admin auth, the spec\'s "not supported" signal', async () => {
    const registry = createRegistry({
      storage: memoryStorage(),
      verifyAdmin: (request) => request.headers.get('authorization') === `Bearer ${TOKEN}`,
    })
    const response = await registry.fetch(
      new Request(`${BASE}/api/v1/auth/sessions`, {method: 'POST'}),
    )
    expect(response.status).toBe(404)
  })
})

describe('token expiry and revocation', () => {
  /** Mint a token the way browser login does, so these tests exercise the real
   *  record rather than a hand-written one. */
  async function mintToken(registry: Registry, app?: string): Promise<string> {
    const session = (await (
      await registry.fetch(
        new Request(`${BASE}/api/v1/auth/sessions`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(app === undefined ? {} : {app}),
        }),
      )
    ).json()) as {loginUrl: string; code: string; userCode: string}
    const form = new FormData()
    form.set('userCode', session.userCode)
    form.set('secret', TOKEN)
    await registry.fetch(new Request(`${BASE}/login`, {method: 'POST', body: form}))
    const claimed = (await (
      await registry.fetch(new Request(`${BASE}/api/v1/auth/sessions/${session.code}/token`))
    ).json()) as {token: string}
    return claimed.token
  }

  function tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  it('records an expiry and refuses the token past it', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const token = await mintToken(registry)

    const record = (await storage.getTokenByHash(tokenHash(token)))!
    expect(Date.parse(record.expiresAt)).toBeGreaterThan(Date.now())
    expect((await publish(registry, {token})).response.status).toBe(201)

    await storage.putToken({...record, expiresAt: new Date(Date.now() - 1000).toISOString()})
    expect((await publish(registry, {token, version: '1.1.0'})).response.status).toBe(401)
  })

  it('treats a record with no parseable expiry as expired', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const token = await mintToken(registry)
    const record = (await storage.getTokenByHash(tokenHash(token)))!
    // A row written before expiries existed must fail closed, not live forever.
    await storage.putToken({...record, expiresAt: undefined as unknown as string})
    expect((await publish(registry, {token})).response.status).toBe(401)
  })

  it('records lastUsedAt on an accepted request', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const token = await mintToken(registry)
    expect((await storage.getTokenByHash(tokenHash(token)))!.lastUsedAt).toBeUndefined()

    await publish(registry, {token})
    const used = (await storage.getTokenByHash(tokenHash(token)))!.lastUsedAt
    expect(Date.parse(used!)).toBeLessThanOrEqual(Date.now())
  })

  it('revokes a token by hash, for the registry secret only', async () => {
    const registry = makeRegistry()
    const token = await mintToken(registry)
    const other = await mintToken(registry)

    const listed = await registry.fetch(
      new Request(`${BASE}/api/v1/auth/tokens`, {headers: {authorization: `Bearer ${TOKEN}`}}),
    )
    const {tokens} = (await listed.json()) as {tokens: {tokenHash: string}[]}
    expect(tokens.map((t) => t.tokenHash)).toContain(tokenHash(token))

    // A minted token is not an admin: it cannot revoke anything, its own
    // hash included.
    const byMinted = await registry.fetch(
      new Request(`${BASE}/api/v1/auth/tokens/${tokenHash(other)}`, {
        method: 'DELETE',
        headers: {authorization: `Bearer ${token}`},
      }),
    )
    expect(byMinted.status).toBe(403)

    const revoked = await registry.fetch(
      new Request(`${BASE}/api/v1/auth/tokens/${tokenHash(token)}`, {
        method: 'DELETE',
        headers: {authorization: `Bearer ${TOKEN}`},
      }),
    )
    expect(revoked.status).toBe(200)
    expect((await publish(registry, {token, version: '2.0.0'})).response.status).toBe(401)
    // The unrevoked one still works.
    expect((await publish(registry, {token: other, version: '2.0.0'})).response.status).toBe(201)
  })

  it('does not serve token management without auth', async () => {
    const registry = makeRegistry()
    const listed = await registry.fetch(new Request(`${BASE}/api/v1/auth/tokens`))
    expect(listed.status).toBe(401)
  })
})

describe('grant scope', () => {
  /** A registry with two apps and one device enrolled per app, plus an
   *  app-scoped token for `sensor`. */
  async function fleet() {
    const registry = makeRegistry()
    const session = (await (
      await registry.fetch(
        new Request(`${BASE}/api/v1/auth/sessions`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({app: 'sensor'}),
        }),
      )
    ).json()) as {loginUrl: string; code: string; userCode: string}
    const form = new FormData()
    form.set('userCode', session.userCode)
    form.set('secret', TOKEN)
    await registry.fetch(new Request(`${BASE}/login`, {method: 'POST', body: form}))
    const {token} = (await (
      await registry.fetch(new Request(`${BASE}/api/v1/auth/sessions/${session.code}/token`))
    ).json()) as {token: string}

    await enroll(registry, 'dev-sensor', {app: 'sensor'})
    await enroll(registry, 'dev-display', {app: 'display'})
    return {registry, token}
  }

  it("lists only the devices of the token's app", async () => {
    const {registry, token} = await fleet()
    const listed = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {headers: {authorization: `Bearer ${token}`}}),
    )
    const {devices} = (await listed.json()) as {devices: {deviceId: string}[]}
    expect(devices.map((d) => d.deviceId)).toEqual(['dev-sensor'])

    // The registry secret still sees the whole fleet.
    const all = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {headers: {authorization: `Bearer ${TOKEN}`}}),
    )
    const {devices: every} = (await all.json()) as {devices: {deviceId: string}[]}
    expect(every).toHaveLength(2)
  })

  it("cannot re-mint another app's device credential", async () => {
    const {registry, token} = await fleet()
    const remint = await registry.fetch(
      new Request(`${BASE}/api/v1/devices/dev-display/credential`, {
        method: 'POST',
        headers: {authorization: `Bearer ${token}`},
      }),
    )
    // 404, not 403: a scoped token must not learn the device exists.
    expect(remint.status).toBe(404)

    const own = await registry.fetch(
      new Request(`${BASE}/api/v1/devices/dev-sensor/credential`, {
        method: 'POST',
        headers: {authorization: `Bearer ${token}`},
      }),
    )
    expect(own.status).toBe(200)
  })

  it('cannot enroll a device into another app', async () => {
    const {registry, token} = await fleet()
    const denied = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {
        method: 'POST',
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
        body: JSON.stringify({deviceId: 'dev-new', app: 'display'}),
      }),
    )
    expect(denied.status).toBe(403)

    // Without an explicit app it inherits the token's, rather than staying free.
    const enrolled = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {
        method: 'POST',
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
        body: JSON.stringify({deviceId: 'dev-new'}),
      }),
    )
    expect(enrolled.status).toBe(201)
    const {device} = (await enrolled.json()) as {device: {app: string}}
    expect(device.app).toBe('sensor')
  })
})

describe('device app binding', () => {
  it('offers only the app the device is bound to, whatever it claims to run', async () => {
    const registry = makeRegistry()
    const display = await publish(registry, {app: 'display', version: '1.0.0'}, 'display-1')
    await publish(registry, {app: 'sensor', version: '1.0.0'}, 'sensor-1')
    const credential = await enroll(registry, 'dev-1', {app: 'sensor'})

    // The device claims to be running the display build. Following that would
    // hand it display's newest build; the binding is what decides.
    const offer = (await (
      await checkin(registry, credential, {running: {checksum: display.checksum, trial: false}})
    ).json()) as {version: string; checksum: string}
    expect(offer.checksum).not.toBe(display.checksum)

    const build = await registry.fetch(
      new Request(`${BASE}/api/v1/builds/${offer.checksum}.tgz`, {
        headers: {authorization: `Bearer ${credential}`},
      }),
    )
    expect(await build.text()).toBe('sensor-1')
  })

  it('withholds every offer while a device is unbound', async () => {
    const registry = makeRegistry()
    await publish(registry, {app: 'sensor', version: '1.0.0'}, 'sensor-1')
    // Enrolled by the unscoped registry secret with no app. Even as the only
    // app on the registry, sensor is not assumed: withholding is the safe
    // answer to a binding nobody has made.
    const credential = await enroll(registry, 'dev-1', {app: undefined})
    expect(await (await checkin(registry, credential)).json()).toBeNull()
  })

  it('never binds an unbound device from what it reports running', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const sensor = await publish(registry, {app: 'sensor', version: '1.0.0'}, 'sensor-1')
    const display = await publish(registry, {app: 'display', version: '1.0.0'}, 'display-1')
    // Enrolling without an app is allowed: binding is the operator's call, not
    // the registry's.
    const credential = await enroll(registry, 'dev-1', {app: undefined})

    // But naming an app's build must not bind the device to that app, or any
    // credential plus a known checksum is a way to pull another app's builds.
    const response = await checkin(registry, credential, {
      running: {checksum: display.checksum, trial: false},
    })
    expect(await response.json()).toBeNull()
    expect((await storage.getDevice('dev-1'))!.app).toBeUndefined()

    // An operator binding it is what unblocks offers, and only to that app.
    await storage.putDevice({...(await storage.getDevice('dev-1'))!, app: 'sensor'})
    const offer = (await (await checkin(registry, credential)).json()) as {checksum: string}
    expect(offer.checksum).toBe(sensor.checksum)
  })
})

describe('check-in validation', () => {
  it('rejects malformed device-reported fields instead of storing them', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const credential = await enroll(registry)

    const cases: Record<string, unknown>[] = [
      {running: {checksum: 'not-a-checksum'}},
      {running: {version: 'v'.repeat(65)}},
      {running: {trial: 'yes'}},
      {running: 'running'},
      {firmware: 'f'.repeat(65)},
      {bytecode: 1.5},
      {lastInstall: 'broke'},
      {lastInstall: {reason: 'r'.repeat(65)}},
      {lastInstall: {reason: 'trial-reverted', detail: 'd'.repeat(257)}},
      {lastInstall: {detail: 'no reason'}},
      {name: [1, 'n'.repeat(65)]},
      {name: ['one', 'kitchen']},
    ]
    for (const body of cases) {
      const response = await checkin(registry, credential, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
    }

    const device = (await storage.getDevice('dev-1'))!
    expect(device.runningChecksum).toBeUndefined()
    expect(device.lastInstall).toBeUndefined()
    expect(device.name).toBeUndefined()
  })

  it('stores a well-formed lastInstall as {reason, detail}', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const credential = await enroll(registry)
    await checkin(registry, credential, {
      lastInstall: {reason: 'trial-reverted', detail: 'watchdog', extra: 'dropped'},
    })
    expect((await storage.getDevice('dev-1'))!.lastInstall).toEqual({
      reason: 'trial-reverted',
      detail: 'watchdog',
    })
  })

  it('requires trial whenever running is reported', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const credential = await enroll(registry, 'dev-1', {app: 'sensor'})
    await checkin(registry, credential, {running: {checksum: 'a'.repeat(64), trial: true}})

    // Required whenever `running` is reported: omitting it would leave the
    // previous `true` standing, and the device would read as trialing forever.
    const response = await checkin(registry, credential, {
      running: {checksum: 'a'.repeat(64)},
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({error: 'Invalid running.trial'})
    expect((await storage.getDevice('dev-1'))!.trial).toBe(true)
  })

  it('404s a malformed percent-escape in a device path instead of throwing', async () => {
    const registry = makeRegistry()
    // Reachable before any auth, and on a bare `{fetch}` export an unhandled
    // rejection rather than a response.
    const response = await registry.fetch(
      new Request(`${BASE}/api/v1/devices/%/credential`, {
        method: 'POST',
        headers: {authorization: `Bearer ${TOKEN}`},
      }),
    )
    expect(response.status).toBe(404)
  })

  it('caps deviceId and name at enrollment', async () => {
    const registry = makeRegistry()
    const longId = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {
        method: 'POST',
        headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
        body: JSON.stringify({deviceId: 'd'.repeat(129)}),
      }),
    )
    expect(longId.status).toBe(400)

    const longName = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {
        method: 'POST',
        headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
        body: JSON.stringify({deviceId: 'dev-2', name: 'n'.repeat(65)}),
      }),
    )
    expect(longName.status).toBe(400)
  })
})

describe('failed checksums', () => {
  it('keeps the list bounded as installs keep failing', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const credential = await enroll(registry, 'dev-1', {app: 'sensor'})

    // Each round publishes a newer build, gets it offered, then fails it.
    const offered: string[] = []
    for (let i = 0; i < 20; i++) {
      await publish(registry, {app: 'sensor', version: `1.0.${i}`}, `sensor-${i}`)
      const offer = (await (await checkin(registry, credential)).json()) as {
        checksum: string
      } | null
      if (offer === null) continue
      offered.push(offer.checksum)
      await checkin(registry, credential, {lastInstall: {reason: 'trial-reverted'}})
    }

    // More failures than the cap, and it is the newest ones that survive.
    expect(offered.length).toBeGreaterThan(16)
    expect((await storage.getDevice('dev-1'))!.failedChecksums).toEqual(offered.slice(-16))
  })

  it('does not blacklist a build the device installed successfully', async () => {
    const storage = memoryStorage()
    const registry = createRegistry({storage, token: TOKEN})
    const {checksum} = await publish(registry)
    const credential = await enroll(registry, 'dev-1', {app: 'sensor'})

    const offer = (await (await checkin(registry, credential)).json()) as {checksum: string}
    expect(offer.checksum).toBe(checksum)
    // The device takes it and leaves trial: that offer is settled.
    await checkin(registry, credential, {running: {checksum, trial: false}})
    // A later diagnostic refers to something else entirely. Attributing it to
    // the settled offer would blacklist the build the device is running, and
    // with it the only rollback target.
    await checkin(registry, credential, {
      running: {checksum, trial: false},
      lastInstall: {reason: 'download-failed'},
    })

    expect((await storage.getDevice('dev-1'))!.failedChecksums).toEqual([])
  })

  it('clears the list on request, so a fixed build can be offered again', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry)
    const credential = await enroll(registry, 'dev-1', {app: 'sensor'})

    await checkin(registry, credential)
    await checkin(registry, credential, {lastInstall: {reason: 'trial-reverted'}})
    expect(await (await checkin(registry, credential)).json()).toBeNull()

    const cleared = await registry.fetch(
      new Request(`${BASE}/api/v1/devices/dev-1/failures`, {
        method: 'DELETE',
        headers: {authorization: `Bearer ${TOKEN}`},
      }),
    )
    expect(cleared.status).toBe(200)

    const offer = (await (await checkin(registry, credential)).json()) as {checksum: string}
    expect(offer.checksum).toBe(checksum)
  })

  it('401s and 404s the reset path for the wrong caller and unknown devices', async () => {
    const registry = makeRegistry()
    await enroll(registry)
    const unauthorized = await registry.fetch(
      new Request(`${BASE}/api/v1/devices/dev-1/failures`, {method: 'DELETE'}),
    )
    expect(unauthorized.status).toBe(401)

    const unknown = await registry.fetch(
      new Request(`${BASE}/api/v1/devices/nope/failures`, {
        method: 'DELETE',
        headers: {authorization: `Bearer ${TOKEN}`},
      }),
    )
    expect(unknown.status).toBe(404)
  })
})

describe('download', () => {
  /** A download takes the device credential and is scoped to the device's own
   *  app, so every case here enrolls a device bound to the app `publish`
   *  defaults to. */
  async function asDevice(registry: Registry): Promise<{authorization: string}> {
    const credential = await enroll(registry, 'dev-1', {app: 'sensor'})
    return {authorization: `Bearer ${credential}`}
  }

  it('serves the exact bytes with an etag, honors Range and If-None-Match', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry, {}, '0123456789')
    const auth = await asDevice(registry)
    const url = `${BASE}/api/v1/builds/${checksum}.tgz`

    const full = await registry.fetch(new Request(url, {headers: auth}))
    expect(full.status).toBe(200)
    expect(await full.text()).toBe('0123456789')

    const partial = await registry.fetch(new Request(url, {headers: {...auth, range: 'bytes=2-5'}}))
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await partial.text()).toBe('2345')

    const tail = await registry.fetch(new Request(url, {headers: {...auth, range: 'bytes=8-'}}))
    expect(await tail.text()).toBe('89')

    const bad = await registry.fetch(new Request(url, {headers: {...auth, range: 'bytes=42-'}}))
    expect(bad.status).toBe(416)

    const cached = await registry.fetch(
      new Request(url, {headers: {...auth, 'if-none-match': `"${checksum}"`}}),
    )
    expect(cached.status).toBe(304)
  })

  it('ignores a Range it cannot parse rather than failing the download', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry)
    const auth = await asDevice(registry)
    // RFC 9110 §14.2: an unparseable Range is ignored and the whole
    // representation served. Only a well-formed unsatisfiable one is a 416.
    for (const range of ['bytes=0-4,6-8', 'items=0-5', 'bytes=abc-', 'nonsense']) {
      const response = await registry.fetch(
        new Request(`${BASE}/api/v1/builds/${checksum}.tgz`, {headers: {...auth, range}}),
      )
      expect(response.status).toBe(200)
    }
    // Well-formed but past the end stays a 416.
    const past = await registry.fetch(
      new Request(`${BASE}/api/v1/builds/${checksum}.tgz`, {
        headers: {...auth, range: 'bytes=9999-'},
      }),
    )
    expect(past.status).toBe(416)
  })

  it('serves the whole build for a suffix range longer than it', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry)
    const auth = await asDevice(registry)
    const full = await (
      await registry.fetch(new Request(`${BASE}/api/v1/builds/${checksum}.tgz`, {headers: auth}))
    ).arrayBuffer()

    const response = await registry.fetch(
      new Request(`${BASE}/api/v1/builds/${checksum}.tgz`, {
        headers: {...auth, range: 'bytes=-9999'},
      }),
    )

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-${full.byteLength - 1}/${full.byteLength}`,
    )
    expect((await response.arrayBuffer()).byteLength).toBe(full.byteLength)
  })

  // A checksum is not a secret: it is printed by `mikro ota publish` and lands
  // in CI logs, so it cannot be the only thing guarding a download. Requiring
  // the credential is also what makes de-enrolling a device stop it downloading.
  it('requires a device credential, and 401s before disclosing whether a build exists', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry)

    const anon = await registry.fetch(new Request(`${BASE}/api/v1/builds/${checksum}.tgz`))
    expect(anon.status).toBe(401)

    // A publish token is not a device credential; the two must not substitute.
    const wrongKind = await registry.fetch(
      new Request(`${BASE}/api/v1/builds/${checksum}.tgz`, {
        headers: {authorization: `Bearer ${TOKEN}`},
      }),
    )
    expect(wrongKind.status).toBe(401)

    // Auth precedes existence, so an unauthenticated caller cannot probe which
    // checksums the registry holds.
    const missing = await registry.fetch(new Request(`${BASE}/api/v1/builds/${'0'.repeat(64)}.tgz`))
    expect(missing.status).toBe(401)
  })

  it('404s an unknown checksum once authenticated', async () => {
    const registry = makeRegistry()
    await publish(registry)
    const auth = await asDevice(registry)
    const missing = await registry.fetch(
      new Request(`${BASE}/api/v1/builds/${'0'.repeat(64)}.tgz`, {headers: auth}),
    )
    expect(missing.status).toBe(404)
  })

  // Authenticating the device proves only that the caller is *a* device. On a
  // registry serving several apps that is not enough: checksums travel in logs.
  it('404s a build belonging to another app', async () => {
    const registry = makeRegistry()
    const sensor = await publish(registry, {app: 'sensor'}, 'sensor-bytes')
    const display = await publish(registry, {app: 'display'}, 'display-bytes')
    const auth = await asDevice(registry)

    const own = await registry.fetch(
      new Request(`${BASE}/api/v1/builds/${sensor.checksum}.tgz`, {headers: auth}),
    )
    expect(own.status).toBe(200)

    const other = await registry.fetch(
      new Request(`${BASE}/api/v1/builds/${display.checksum}.tgz`, {headers: auth}),
    )
    expect(other.status).toBe(404)
  })

  it('404s every build for a device with no app yet', async () => {
    const registry = makeRegistry()
    const {checksum} = await publish(registry)
    // Not the `enroll` helper: it defaults to the app `publish` uses, and the
    // point here is a device that never got one.
    const enrolled = await registry.fetch(
      new Request(`${BASE}/api/v1/devices`, {
        method: 'POST',
        headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
        body: JSON.stringify({deviceId: 'dev-unbound'}),
      }),
    )
    const {credential} = (await enrolled.json()) as {credential: string}
    const response = await registry.fetch(
      new Request(`${BASE}/api/v1/builds/${checksum}.tgz`, {
        headers: {authorization: `Bearer ${credential}`},
      }),
    )
    expect(response.status).toBe(404)
  })
})

describe('concurrent device writes', () => {
  /** Every call yields to the macrotask queue, the way a file- or
   *  network-backed store does. memoryStorage resolves without yielding, which
   *  is enough on its own to hide an interleaving a real backend hits. */
  function slow(inner: RegistryStorage): RegistryStorage {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1))
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(inner as unknown as Record<string, unknown>)) {
      out[key] =
        typeof value === 'function'
          ? async (...args: unknown[]) => {
              await tick()
              return (value as (...a: unknown[]) => unknown).apply(inner, args)
            }
          : value
    }
    return out as unknown as RegistryStorage
  }

  // Re-minting is how a leaked credential is revoked, so a write that quietly
  // undoes it is a revocation failure: the leaked credential goes on working and
  // the operator's replacement does not. A check-in reads the device, then
  // awaits several times before writing the record it read back.
  it('a check-in racing a re-mint cannot revive the revoked credential', async () => {
    const registry = createRegistry({storage: slow(memoryStorage()), token: TOKEN})
    const leaked = await enroll(registry, 'dev-1')

    const [, reminted] = await Promise.all([
      checkin(registry, leaked),
      registry.fetch(
        new Request(`${BASE}/api/v1/devices/dev-1/credential`, {
          method: 'POST',
          headers: {authorization: `Bearer ${TOKEN}`},
        }),
      ),
    ])
    const {credential: fresh} = (await reminted.json()) as {credential: string}

    expect((await checkin(registry, leaked)).status).toBe(401)
    expect((await checkin(registry, fresh)).status).toBe(200)
  })

  // Same shape, without the security consequence: a check-in's write must not
  // resurrect the failure list an operator just cleared.
  it('a check-in racing a failure reset does not restore the cleared list', async () => {
    const storage = slow(memoryStorage())
    const registry = createRegistry({storage, token: TOKEN})
    await publish(registry)
    const credential = await enroll(registry, 'dev-1')
    await checkin(registry, credential)
    await checkin(registry, credential, {lastInstall: {reason: 'trial-reverted'}})
    expect((await storage.getDevice('dev-1'))!.failedChecksums).toHaveLength(1)

    await Promise.all([
      checkin(registry, credential),
      registry.fetch(
        new Request(`${BASE}/api/v1/devices/dev-1/failures`, {
          method: 'DELETE',
          headers: {authorization: `Bearer ${TOKEN}`},
        }),
      ),
    ])
    expect((await storage.getDevice('dev-1'))!.failedChecksums).toEqual([])
  })
})

describe('name sync', () => {
  // These need to read and edit the stored record directly, so they build the
  // registry over a storage handle the test keeps.
  function makeWithStorage() {
    const storage = memoryStorage()
    return {storage, registry: createRegistry({storage, token: TOKEN})}
  }

  /** Rename the stored record directly, standing in for a dashboard edit. */
  async function renameInRegistry(storage: RegistryStorage, name: string | undefined) {
    const device = (await storage.getDevice('dev-1'))!
    await storage.putDevice({...device, name, nameRev: (device.nameRev ?? 0) + 1})
  }

  async function storedName(storage: RegistryStorage) {
    const device = (await storage.getDevice('dev-1'))!
    return {name: device.name, rev: device.nameRev ?? 0}
  }

  it('adopts the device pair when the device revision is higher (rule 1)', async () => {
    const {registry, storage} = makeWithStorage()
    const credential = await enroll(registry)

    const body = await (await checkin(registry, credential, {name: [3, 'kitchen']})).json()

    expect(await storedName(storage)).toEqual({name: 'kitchen', rev: 3})
    // Nothing to send back: the device is already the source of truth.
    expect(body).toBeNull()
  })

  it('sends its own pair down when the registry revision is higher (rule 2)', async () => {
    const {registry, storage} = makeWithStorage()
    const credential = await enroll(registry)
    await renameInRegistry(storage, 'garage')

    const body = (await (await checkin(registry, credential, {name: [0]})).json()) as {
      name: [number, string?]
    }

    expect(body.name).toEqual([1, 'garage'])
    // The registry keeps its own; the device adopts.
    expect(await storedName(storage)).toEqual({name: 'garage', rev: 1})
  })

  it('does nothing when revisions and names agree (rule 3)', async () => {
    const {registry, storage} = makeWithStorage()
    const credential = await enroll(registry)
    await checkin(registry, credential, {name: [2, 'kitchen']})

    const body = await (await checkin(registry, credential, {name: [2, 'kitchen']})).json()

    expect(body).toBeNull()
    expect(await storedName(storage)).toEqual({name: 'kitchen', rev: 2})
  })

  it('wins the tie at a bumped revision on a concurrent rename (rule 4)', async () => {
    const {registry, storage} = makeWithStorage()
    const credential = await enroll(registry)
    await renameInRegistry(storage, 'garage')

    // Both sides renamed at revision 1 before either synced.
    const body = (await (await checkin(registry, credential, {name: [1, 'kitchen']})).json()) as {
      name: [number, string?]
    }

    // The registry wins, at rev+1 so the pair converges and cannot ping-pong.
    expect(body.name).toEqual([2, 'garage'])
    expect(await storedName(storage)).toEqual({name: 'garage', rev: 2})
    // The losing name is kept, so an operator can see the rename was overruled
    // rather than lost. Whoever renamed at the cable only sees it flip back.
    expect((await storage.getDevice('dev-1'))!.discardedName).toBe('kitchen')
  })

  it('drops the discarded name once the two sides converge', async () => {
    const {registry, storage} = makeWithStorage()
    const credential = await enroll(registry)
    await renameInRegistry(storage, 'garage')
    await checkin(registry, credential, {name: [1, 'kitchen']})
    expect((await storage.getDevice('dev-1'))!.discardedName).toBe('kitchen')

    // The device adopted 'garage' at rev 2 and reports it back: rule 3, in sync.
    await checkin(registry, credential, {name: [2, 'garage']})
    expect((await storage.getDevice('dev-1'))!.discardedName).toBeUndefined()
  })

  it('drops the discarded name when the device redoes its rename and wins', async () => {
    const {registry, storage} = makeWithStorage()
    const credential = await enroll(registry)
    await renameInRegistry(storage, 'garage')
    await checkin(registry, credential, {name: [1, 'kitchen']})

    // Renamed again at the cable, now at a higher revision: rule 1, device wins.
    const body = await (await checkin(registry, credential, {name: [3, 'kitchen']})).json()

    expect(body).toBeNull()
    expect(await storedName(storage)).toEqual({name: 'kitchen', rev: 3})
    expect((await storage.getDevice('dev-1'))!.discardedName).toBeUndefined()
  })

  it('propagates a cleared name instead of resurrecting the old one', async () => {
    const {registry, storage} = makeWithStorage()
    const credential = await enroll(registry)
    await checkin(registry, credential, {name: [1, 'kitchen']})

    // The device cleared its name: same shape, no second element.
    const body = await (await checkin(registry, credential, {name: [2]})).json()

    expect(body).toBeNull()
    expect(await storedName(storage)).toEqual({name: undefined, rev: 2})
  })

  it('leaves the name untouched for firmware that sends no pair', async () => {
    const {registry, storage} = makeWithStorage()
    const credential = await enroll(registry)
    await renameInRegistry(storage, 'garage')

    const body = await (await checkin(registry, credential)).json()

    expect(body).toBeNull()
    expect(await storedName(storage)).toEqual({name: 'garage', rev: 1})
  })

  it('adopts the name of a device the registry never named (rule 4a)', async () => {
    const {registry, storage} = makeWithStorage()
    // Enrolled without a name, so the registry has never made a naming
    // decision. The device arrives carrying its derived seed name at rev 0.
    const credential = await enroll(registry, 'dev-1', {app: 'sensor', name: undefined})

    const body = await (await checkin(registry, credential, {name: [0, 'kitchen']})).json()

    // Winning this tie would have ordered the device to clear the only name
    // either side has.
    expect(await storedName(storage)).toEqual({name: 'kitchen', rev: 0})
    expect(body).toBeNull()
  })

  it('still defends a name the registry deliberately cleared (rule 4b)', async () => {
    const {registry, storage} = makeWithStorage()
    const credential = await enroll(registry, 'dev-1', {app: 'sensor', name: 'kitchen'})
    // Cleared in the registry, which is a decision and carries a revision.
    // That is what separates it from "never named".
    await renameInRegistry(storage, undefined)
    await checkin(registry, credential, {name: [1, 'kitchen']})

    // Device reports the stale name at the same revision: the registry wins.
    const body = (await (await checkin(registry, credential, {name: [1, 'kitchen']})).json()) as {
      name: [number, string?]
    } | null
    expect(body?.name).toEqual([2])
    expect(await storedName(storage)).toEqual({name: undefined, rev: 2})
  })

  it('treats a record with no revision as revision 0', async () => {
    const {registry, storage} = makeWithStorage()
    const credential = await enroll(registry)
    const device = (await storage.getDevice('dev-1'))!
    // A legacy row: named, but stored before revisions existed.
    await storage.putDevice({...device, name: 'legacy'})

    // The device renamed over the cable reports rev 1 and wins this first sync.
    const body = await (await checkin(registry, credential, {name: [1, 'bench']})).json()

    expect(body).toBeNull()
    expect(await storedName(storage)).toEqual({name: 'bench', rev: 1})
  })

  it('rejects a revision so large the registry could never win a rename back', async () => {
    const {registry, storage} = makeWithStorage()
    const credential = await enroll(registry)
    await checkin(registry, credential, {name: [1, 'kitchen']})
    // Rule 4b answers a tie with `ourRev + 1`, which stops incrementing near
    // MAX_SAFE_INTEGER, so a device reporting a huge revision would otherwise
    // pin its own name permanently.
    for (const rev of [1e308, Number.MAX_SAFE_INTEGER, 2 ** 53]) {
      const response = await checkin(registry, credential, {name: [rev, 'pinned']})
      expect(response.status).toBe(400)
    }
    expect((await storedName(storage)).name).not.toBe('pinned')
  })
})

describe('node adapter', () => {
  /** A real server on an ephemeral port, torn down with the test. */
  async function withServer(
    handler: Registry,
    options: {maxBodyBytes?: number} = {},
  ): Promise<{origin: string; close: () => void}> {
    const {serve} = await import('../node.js')
    const server = serve(handler, {port: 0, hostname: '127.0.0.1', ...options})
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address() as {port: number}
    return {origin: `http://127.0.0.1:${address.port}`, close: () => server.close()}
  }

  it('builds offer urls from the forwarded scheme behind a TLS proxy', async () => {
    const registry = makeRegistry()
    await publish(registry)
    const credential = await enroll(registry, 'dev-1', {app: 'sensor'})
    const {origin, close} = await withServer(registry)
    try {
      // The socket is plain http, but the device rejects a non-https offer
      // url outright, so the proxy's scheme is the one that has to be used.
      const response = await fetch(`${origin}/api/v1/checkin`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({firmware: '0.15.0', bytecode: 13, running: {trial: false}}),
      })
      const offer = (await response.json()) as {url: string}
      expect(offer.url.startsWith('https://')).toBe(true)
    } finally {
      close()
    }
  })

  it('413s an oversized body without buffering it', async () => {
    const {origin, close} = await withServer(makeRegistry(), {maxBodyBytes: 1024})
    try {
      // Unauthenticated, so the cap must bite before routing or auth.
      const response = await fetch(`${origin}/api/v1/builds`, {
        method: 'POST',
        body: new Uint8Array(64 * 1024),
      })
      expect(response.status).toBe(413)

      const small = await fetch(`${origin}/api/v1/checkin`, {
        method: 'POST',
        headers: {authorization: 'Bearer dvc_nope', 'content-type': 'application/json'},
        body: JSON.stringify({deviceId: 'dev-1'}),
      })
      expect(small.status).toBe(401)
    } finally {
      close()
    }
  })

  it('does not leak internal error messages to clients', async () => {
    const failing: Registry = {
      fetch: () => Promise.reject(new Error('ENOENT: /srv/registry/data/devices.json')),
    }
    const {origin, close} = await withServer(failing)
    try {
      const response = await fetch(`${origin}/api/v1/devices`)
      expect(response.status).toBe(500)
      const body = (await response.json()) as {error: string}
      expect(body.error).toBe('Internal server error')
      expect(JSON.stringify(body)).not.toContain('/srv/registry')
    } finally {
      close()
    }
  })

  it('overrides a client-supplied peer-address header', async () => {
    // Otherwise a client picks its own rate-limit bucket and never backs off.
    const registry = makeRegistry()
    const {origin, close} = await withServer(registry)
    try {
      const session = (await (
        await fetch(`${origin}/api/v1/auth/sessions`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: '{}',
        })
      ).json()) as {loginUrl: string; code: string; userCode: string}

      for (let i = 0; i < 5; i++) {
        const form = new FormData()
        form.set('userCode', session.userCode)
        form.set('secret', 'wrong')
        const response = await fetch(`${origin}/login`, {
          method: 'POST',
          // A fresh spoofed address per attempt: it must not buy a fresh bucket.
          headers: {'mikro-client-ip': `10.1.1.${i}`},
          body: form,
        })
        if (i === 4) expect(response.status).toBe(429)
      }
    } finally {
      close()
    }
  })

  it('fileStorage does not confuse prototype keys with records', async () => {
    const {fileStorage} = await import('../node.js')
    const {mkdtempSync} = await import('node:fs')
    const {tmpdir} = await import('node:os')
    const {join} = await import('node:path')
    const storage = fileStorage(mkdtempSync(join(tmpdir(), 'registry-')))
    const registry = createRegistry({storage, token: TOKEN})

    // `constructor` and `__proto__` are ordinary misses, not inherited hits.
    expect(await storage.getDevice('constructor')).toBeUndefined()
    expect(await storage.getTokenByHash('__proto__')).toBeUndefined()

    const remint = await registry.fetch(
      new Request(`${BASE}/api/v1/devices/constructor/credential`, {
        method: 'POST',
        headers: {authorization: `Bearer ${TOKEN}`},
      }),
    )
    expect(remint.status).toBe(404)

    // A device really named `constructor` stores and reads back as itself,
    // and does not pollute anything else.
    await enroll(registry, 'constructor')
    expect((await storage.getDevice('constructor'))!.deviceId).toBe('constructor')
    expect(await storage.getDevice('toString')).toBeUndefined()
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(await storage.listDevices()).toHaveLength(1)
  })

  it('fileStorage never leaves a half-written index behind', async () => {
    const {mkdtempSync, readdirSync, readFileSync} = await import('node:fs')
    const {tmpdir} = await import('node:os')
    const {join} = await import('node:path')
    const {fileStorage} = await import('../node.js')

    const dir = mkdtempSync(join(tmpdir(), 'mikro-registry-'))
    const storage = fileStorage(dir)
    const registry = createRegistry({storage, token: TOKEN})
    await publish(registry)
    const credential = await enroll(registry, 'dev-1', {app: 'sensor'})
    await checkin(registry, credential)

    // devices.json is rewritten in full on every check-in and holds every
    // credential hash, so it is written to a temp file and renamed: a kill
    // mid-write must not truncate it into an unenrolled fleet.
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'devices.json'), 'utf-8'))['dev-1'].app).toBe('sensor')
  })

  it('fileStorage serves an index edited underneath it', async () => {
    const {mkdtempSync, writeFileSync} = await import('node:fs')
    const {tmpdir} = await import('node:os')
    const {join} = await import('node:path')
    const {fileStorage} = await import('../node.js')

    const dir = mkdtempSync(join(tmpdir(), 'mikro-registry-'))
    const storage = fileStorage(dir)
    await storage.putDevice({deviceId: 'dev-1', credentialHash: 'aa', failedChecksums: []})
    expect((await storage.getDevice('dev-1'))!.credentialHash).toBe('aa')

    // Indexes are cached and invalidated by mtime, so an operator editing the
    // file must not be served a stale record.
    await new Promise((resolve) => setTimeout(resolve, 10))
    writeFileSync(
      join(dir, 'devices.json'),
      JSON.stringify({'dev-1': {deviceId: 'dev-1', credentialHash: 'bb', failedChecksums: []}}),
    )
    expect((await storage.getDevice('dev-1'))!.credentialHash).toBe('bb')
    expect(await storage.getDeviceByCredentialHash('bb')).toBeDefined()
  })
})

describe('identity document', () => {
  // How `mikro ota setup` recognizes a registry before it commits a token.
  it('serves {name} at the root', async () => {
    const res = await makeRegistry().fetch(new Request(`${BASE}/`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({name: 'mikro-registry'})
  })

  it('includes the build version when configured', async () => {
    const registry = createRegistry({storage: memoryStorage(), token: TOKEN, version: 'abc123'})
    const res = await registry.fetch(new Request(`${BASE}/`))
    expect(await res.json()).toEqual({name: 'mikro-registry', version: 'abc123'})
  })
})
