/**
 * Check-in wire fixtures: response bodies captured from the real reference
 * registry, replayed by test/ota_wire_fixtures_test.cpp.
 *
 * The reference registry (packages/@mikrojs/registry) and the device check-in
 * client (src/mik_ota_client.cpp) implement one wire contract with two
 * independent test suites, and they drifted: the registry answers a
 * nothing-new check-in with CBOR null, the C client required a map, and every
 * quiet round on real devices failed to the 60s retry cadence while both
 * suites stayed green (fixed in c41feb3). The C++ suite's fakes only ever
 * produced the shapes the test author imagined — CheckinResponse{}.Encode() is
 * always a map. These fixtures make the client's round logic consume bytes the
 * real registry produced, so a response-shape change on either side breaks a
 * test instead of a fleet.
 *
 * Deterministic and offline: fixed device id, app, versions and build bytes,
 * and nothing clock-derived reaches a response body.
 *
 * Requires the registry's built dist, so run `pnpm build:ts` first.
 *
 * Usage: node gen-checkin-fixtures.js <outdir>
 */

import {createHash} from 'node:crypto'
import {mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {createRegistry, memoryStorage} from '@mikrojs/registry'

// The registry picks its response format from the request's content-type, so a
// fixture that captures what a device receives has to POST CBOR. The codec is
// not part of the package's public exports; take it from beside the entry point
// rather than growing a second encoder here.
const {decodeCbor, encodeCbor} = await import(
  new URL('./cbor.js', import.meta.resolve('@mikrojs/registry')).href
)

const outDir = process.argv[2]
if (!outDir) {
  // eslint-disable-next-line no-console
  console.error('Usage: node gen-checkin-fixtures.js <outdir>')
  process.exit(1)
}

const TOKEN = 'tok_fixture'
const BASE = 'https://reg.example'
const DEVICE_ID = 'dev-1'
const APP = 'sensor'
const FIRMWARE = '0.16.0'
const BYTECODE = 42

/** One defaulted leaf: valid with no operator input at all. */
const SCHEMA = JSON.stringify({kind: 'object', shape: {interval: {kind: 'number', default: 60}}})

function fresh() {
  const storage = memoryStorage()
  return {storage, registry: createRegistry({storage, token: TOKEN})}
}

async function publish(registry, {version, content, configSchema}) {
  const bytes = new TextEncoder().encode(content)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const form = new FormData()
  form.set('app', APP)
  form.set('version', version)
  form.set('checksum', checksum)
  form.set('size', String(bytes.byteLength))
  form.set('firmwareVersion', FIRMWARE)
  form.set('bytecodeVersion', String(BYTECODE))
  // A stored build is served to no device until a channel points at it.
  form.set('channel', 'main')
  if (configSchema !== undefined) form.set('configSchema', configSchema)
  form.set('build', new Blob([bytes], {type: 'application/gzip'}), 'app.tgz')
  const response = await registry.fetch(
    new Request(`${BASE}/api/v1/builds`, {
      method: 'POST',
      headers: {authorization: `Bearer ${TOKEN}`},
      body: form,
    }),
  )
  if (response.status !== 201) throw new Error(`publish ${version}: ${await response.text()}`)
  return {checksum, size: bytes.byteLength}
}

async function enroll(registry) {
  const response = await registry.fetch(
    new Request(`${BASE}/api/v1/devices`, {
      method: 'POST',
      headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
      body: JSON.stringify({deviceId: DEVICE_ID, app: APP}),
    }),
  )
  if (response.status !== 201) throw new Error(`enroll: ${await response.text()}`)
  return (await response.json()).credential
}

async function putConfig(registry, body) {
  const response = await registry.fetch(
    new Request(`${BASE}/api/v1/devices/${DEVICE_ID}/config`, {
      method: 'PUT',
      headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'},
      body: JSON.stringify(body),
    }),
  )
  if (response.status !== 200) throw new Error(`putConfig: ${await response.text()}`)
}

/** A check-in body exactly as encode_report() in mik_ota_client.cpp sends it. */
function checkin(registry, credential, extra = {}) {
  return registry.fetch(
    new Request(`${BASE}/api/v1/checkin`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/cbor',
        accept: 'application/cbor',
      },
      body: encodeCbor({
        deviceId: DEVICE_ID,
        firmware: FIRMWARE,
        firmwareHash: 'fwhash',
        bytecode: BYTECODE,
        running: {trial: false},
        name: [1, 'shed'],
        free: 900000,
        ...extra,
      }),
    }),
  )
}

/** The rev the registry hands down for the running release's overlay. */
async function revFrom(response) {
  const body = decodeCbor(new Uint8Array(await response.arrayBuffer()))
  return body.config.rev
}

/** What the device must conclude, with every field always present so the C++
 *  reader stays a flat lookup. `nameRev` -1 means "no rename expected". */
function expect({
  result,
  configUpdated = false,
  offer,
  configStaged = false,
  nameRev = -1,
  name = '',
}) {
  return {
    result,
    configUpdated,
    offerUrl: offer?.url ?? '',
    offerChecksum: offer?.checksum ?? '',
    offerSize: offer?.size ?? 0,
    configStaged,
    nameRev,
    name,
  }
}

const scenarios = [
  {
    scenario: 'quiet-round',
    note: 'nothing to offer, nothing to configure: the registry answers CBOR null',
    expect: expect({result: 'up-to-date'}),
    async capture() {
      const {registry} = fresh()
      return checkin(registry, await enroll(registry))
    },
  },
  {
    scenario: 'config-delivered',
    note: 'an operator overlay for the running release, not yet held by the device',
    expect: expect({result: 'up-to-date', configUpdated: true}),
    async capture() {
      const {registry} = fresh()
      const build = await publish(registry, {
        version: '1.0.0',
        content: 'build-1.0.0',
        configSchema: SCHEMA,
      })
      const credential = await enroll(registry)
      await putConfig(registry, {values: {interval: 30}, version: '1.0.0'})
      return checkin(registry, credential, {
        running: {checksum: build.checksum, version: '1.0.0', trial: false},
      })
    },
  },
  {
    scenario: 'config-rev-echoed',
    note: 'the device echoes the rev it holds: the registry sends nothing back',
    expect: expect({result: 'up-to-date'}),
    async capture() {
      const {registry} = fresh()
      const build = await publish(registry, {
        version: '1.0.0',
        content: 'build-1.0.0',
        configSchema: SCHEMA,
      })
      const credential = await enroll(registry)
      await putConfig(registry, {values: {interval: 30}, version: '1.0.0'})
      const running = {checksum: build.checksum, version: '1.0.0', trial: false}
      const rev = await revFrom(await checkin(registry, credential, {running}))
      return checkin(registry, credential, {running, configRev: rev})
    },
  },
  {
    scenario: 'config-cleared',
    note: 'the overlay was removed: a config field with a version and no doc',
    expect: expect({result: 'up-to-date', configUpdated: true}),
    async capture() {
      const {registry} = fresh()
      const build = await publish(registry, {
        version: '1.0.0',
        content: 'build-1.0.0',
        configSchema: SCHEMA,
      })
      const credential = await enroll(registry)
      await putConfig(registry, {values: {interval: 30}, version: '1.0.0'})
      const running = {checksum: build.checksum, version: '1.0.0', trial: false}
      const rev = await revFrom(await checkin(registry, credential, {running}))
      await putConfig(registry, {values: {}, version: '1.0.0'})
      // The device still holds the delivered document, so the test seeds it.
      this.seedConfigRev = rev
      return checkin(registry, credential, {running, configRev: rev})
    },
  },
  {
    scenario: 'name-changed',
    note: 'renamed registry-side at a higher revision: the pair comes back alone',
    expect: expect({result: 'up-to-date', nameRev: 3, name: 'kitchen'}),
    async capture() {
      const {registry, storage} = fresh()
      const credential = await enroll(registry)
      const device = await storage.getDevice(DEVICE_ID)
      await storage.putDevice({...device, name: 'kitchen', nameRev: 3})
      return checkin(registry, credential)
    },
  },
  {
    scenario: 'offer',
    note: 'a newer build for this firmware range',
    async capture() {
      const {registry} = fresh()
      const first = await publish(registry, {version: '1.0.0', content: 'build-1.0.0'})
      const next = await publish(registry, {version: '2.0.0', content: 'build-2.0.0'})
      const credential = await enroll(registry)
      this.expect = expect({
        result: 'staged',
        offer: {
          url: `${BASE}/api/v1/builds/${next.checksum}.tgz`,
          checksum: next.checksum,
          size: next.size,
        },
      })
      return checkin(registry, credential, {
        running: {checksum: first.checksum, version: '1.0.0', trial: false},
      })
    },
  },
  {
    scenario: 'offer-with-config',
    note: "the offer and the offered release's config travel together (offer rule 5)",
    async capture() {
      const {registry} = fresh()
      const first = await publish(registry, {
        version: '1.0.0',
        content: 'build-1.0.0',
        configSchema: SCHEMA,
      })
      const next = await publish(registry, {
        version: '2.0.0',
        content: 'build-2.0.0',
        configSchema: SCHEMA,
      })
      const credential = await enroll(registry)
      await putConfig(registry, {values: {interval: 30}, version: '2.0.0'})
      this.expect = expect({
        result: 'staged',
        configStaged: true,
        offer: {
          url: `${BASE}/api/v1/builds/${next.checksum}.tgz`,
          checksum: next.checksum,
          size: next.size,
        },
      })
      return checkin(registry, credential, {
        running: {checksum: first.checksum, version: '1.0.0', trial: false},
      })
    },
  },
  {
    scenario: 'unauthorized',
    note: 'a credential the registry does not know: 401 with a JSON error body',
    expect: expect({result: 'unauthorized'}),
    async capture() {
      const {registry} = fresh()
      await enroll(registry)
      return checkin(registry, 'duk_wrong')
    },
  },
]

rmSync(outDir, {recursive: true, force: true})
mkdirSync(outDir, {recursive: true})

const manifest = []
for (const [index, entry] of scenarios.entries()) {
  entry.seedConfigRev = ''
  const response = await entry.capture()
  const body = new Uint8Array(await response.arrayBuffer())
  const file = `${String(index + 1).padStart(2, '0')}-${entry.scenario}.cbor`
  writeFileSync(join(outDir, file), body)
  manifest.push({
    file,
    scenario: entry.scenario,
    note: entry.note,
    status: response.status,
    seedConfigRev: entry.seedConfigRev,
    expect: entry.expect,
  })
}

writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
