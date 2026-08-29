import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
  buildConfigDefaults,
  clearStaleConfigState,
  CONFIG_STALE_KVS,
  serializeConfigSchema,
  writeDevManifest,
} from '../configSchema.js'

describe('serializeConfigSchema', () => {
  it('rejects a schema whose defaults alone exceed the document cap', () => {
    const config = {
      otaConfigSchema: {
        kind: 'object',
        shape: {blob: {kind: 'string', default: 'x'.repeat(5000)}},
      },
    }
    expect(() => serializeConfigSchema(config as never)).toThrow(/defaults alone/)
  })
})

describe('annotations through the pack path', () => {
  // Mirrors examples/ota/app/ota.config.ts, which is the schema this feature
  // exists for. Written as a plain AST rather than importing the constructors
  // so the test also covers what an untrusted serialized schema must survive.
  const annotated = {
    otaConfigSchema: {
      kind: 'object',
      title: 'Blinky',
      shape: {
        pin: {
          kind: 'number',
          title: 'LED pin',
          description: 'GPIO the LED is wired to.',
          default: 15,
          min: 0,
          max: 30,
          integer: true,
        },
        broker: {kind: 'string', format: 'url', mask: false, default: 'mqtt://localhost'},
        interval: {kind: 'number', unit: 'ms', default: 400},
      },
    },
  }

  it('carries every annotation into the serialized schema', () => {
    const serialized = serializeConfigSchema(annotated as never) as {
      shape: Record<string, Record<string, unknown>>
      title: string
    }
    expect(serialized.title).toBe('Blinky')
    expect(serialized.shape.pin).toMatchObject({
      title: 'LED pin',
      description: 'GPIO the LED is wired to.',
      min: 0,
      max: 30,
      integer: true,
    })
    expect(serialized.shape.broker).toMatchObject({format: 'url'})
    expect(serialized.shape.interval).toMatchObject({unit: 'ms'})
  })

  it('keeps annotations out of configDefaults, which is what the device reads', () => {
    const defaults = buildConfigDefaults(serializeConfigSchema(annotated as never))
    expect(defaults).toEqual({pin: 15, broker: 'mqtt://localhost', interval: 400})
  })

  it('rejects a schema whose default breaks its own constraint', () => {
    const bad = {
      otaConfigSchema: {
        kind: 'object',
        shape: {pin: {kind: 'number', default: 200, max: 30}},
      },
    }
    expect(() => serializeConfigSchema(bad as never)).toThrow(/above the maximum of 30/)
  })

  it('rejects an unrecognised constraint value rather than dropping it', () => {
    const bad = {
      otaConfigSchema: {kind: 'object', shape: {x: {kind: 'string', format: 'ipv6'}}},
    }
    expect(() => serializeConfigSchema(bad as never)).toThrow(/unknown format/)
  })
})

describe('writeDevManifest', () => {
  let dir: string
  let buildDir: string

  beforeEach(() => {
    dir = mkdtempSync(pathlib.join(tmpdir(), 'dev-config-'))
    buildDir = mkdtempSync(pathlib.join(tmpdir(), 'dev-build-'))
    writeFileSync(
      pathlib.join(dir, 'package.json'),
      JSON.stringify({name: 'probe', version: '1.2.3', type: 'module'}),
    )
  })

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true})
    rmSync(buildDir, {recursive: true, force: true})
  })

  // The build tree has no app/ directory yet (dev sync builds incrementally):
  // the manifest write must create it, matching writeManifest, instead of
  // failing with a raw ENOENT on every dev round.
  it('writes the app/ manifest with the materialized defaults, creating app/', async () => {
    writeFileSync(
      pathlib.join(dir, 'mikro.config.ts'),
      `export default {otaConfigSchema: {kind: 'object', shape: {interval: {kind: 'number', default: 60}}}}\n`,
    )
    await writeDevManifest({projectRoot: dir, buildDir})
    const manifest = JSON.parse(
      readFileSync(pathlib.join(buildDir, 'app', 'mikro.app.json'), 'utf-8'),
    )
    expect(manifest).toEqual({
      app: 'probe',
      version: '1.2.3',
      configDefaults: {interval: 60},
    })
  })

  it('does nothing for apps without a schema', async () => {
    writeFileSync(pathlib.join(dir, 'mikro.config.ts'), 'export default {}\n')
    await writeDevManifest({projectRoot: dir, buildDir})
    expect(existsSync(pathlib.join(buildDir, 'app', 'mikro.app.json'))).toBe(false)
  })
})

describe('clearStaleConfigState', () => {
  it('drops the pairing state and touches nothing else', async () => {
    const writes: string[] = []
    const kv = {
      delete: async (key: string) => void writes.push(`delete ${key}`),
    }
    await clearStaleConfigState(kv)
    expect(writes).toEqual(CONFIG_STALE_KVS.map((k) => `delete ${k}`))
    // The delivered document slot (`ota.cfg`) is deliberately not among them.
    expect(CONFIG_STALE_KVS).not.toContain('ota.cfg')
  })
})

describe('buildConfigDefaults', () => {
  it('materializes the partial defaults', () => {
    const schema = {kind: 'object', shape: {interval: {kind: 'number', default: 60}}}
    expect(buildConfigDefaults(schema)).toEqual({interval: 60})
  })

  it('is undefined only when the app declares no schema', () => {
    expect(buildConfigDefaults(undefined)).toBeUndefined()
    // A schema nothing fills still carries defaults: an empty object.
    expect(buildConfigDefaults({kind: 'object', shape: {url: {kind: 'string'}}})).toEqual({})
  })
})
