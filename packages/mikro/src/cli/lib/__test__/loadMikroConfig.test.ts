import {mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'
import {pathToFileURL} from 'node:url'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {rewriteConfigImports} from '../loadMikroConfig.js'

const SCHEMA_URL = 'file:///resolved/mikro/schema.js'

describe('rewriteConfigImports', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(pathlib.join(tmpdir(), 'mikro-config-'))
    configPath = pathlib.join(dir, 'mikro.config.ts')
  })

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true})
  })

  it('shims the bare mikro import', () => {
    const out = rewriteConfigImports(
      `import {defineConfig} from 'mikro'\nexport default defineConfig({})\n`,
      dir,
      configPath,
      SCHEMA_URL,
    )
    expect(out).not.toContain(`'mikro'`)
    expect(out).toContain('const defineConfig = (c) => c;')
  })

  it('rewrites mikro/schema to the resolved host implementation', () => {
    const out = rewriteConfigImports(
      `import {object, number} from 'mikro/schema'\nexport default {otaConfigSchema: object({n: number()})}\n`,
      dir,
      configPath,
      SCHEMA_URL,
    )
    expect(out).toContain(`from '${SCHEMA_URL}'`)
    expect(out).not.toContain(`'mikro/schema'`)
  })

  it('rejects other device modules with a clear message', () => {
    expect(() =>
      rewriteConfigImports(`import {wifi} from 'mikro/wifi'\n`, dir, configPath, SCHEMA_URL),
    ).toThrow(/mikro\/wifi.*device-only/s)
  })

  it('resolves relative imports against the config directory', () => {
    mkdirSync(pathlib.join(dir, 'src'))
    const target = pathlib.join(dir, 'src', 'config.mjs')
    writeFileSync(target, 'export const x = 1\n')
    const out = rewriteConfigImports(
      `import {x} from './src/config.mjs'\n`,
      dir,
      configPath,
      SCHEMA_URL,
    )
    expect(out).toContain(`from '${pathToFileURL(target).href}?v=`)
  })

  it('falls back from a .js specifier to the .ts source when only that exists', () => {
    mkdirSync(pathlib.join(dir, 'src'))
    const target = pathlib.join(dir, 'src', 'config.ts')
    writeFileSync(target, 'export const x = 1\n')
    const out = rewriteConfigImports(
      `import {x} from './src/config.js'\n`,
      dir,
      configPath,
      SCHEMA_URL,
    )
    expect(out).toContain(`from '${pathToFileURL(target).href}?v=`)
  })

  // ESM caches by URL for the process lifetime; without a changing query an
  // edited schema module would stay stale for a whole `mikro dev` session.
  it('gives an edited relative import a new URL', () => {
    mkdirSync(pathlib.join(dir, 'src'))
    const target = pathlib.join(dir, 'src', 'config.ts')
    const source = `import {x} from './src/config.js'\n`
    writeFileSync(target, 'export const x = 1\n')
    const before = rewriteConfigImports(source, dir, configPath, SCHEMA_URL)
    const past = new Date(Date.now() - 60_000)
    utimesSync(target, past, past)
    const after = rewriteConfigImports(source, dir, configPath, SCHEMA_URL)
    expect(after).not.toEqual(before)
  })

  // The schema module usually re-exports from siblings; an edit there must
  // bust the cache too, or it stays stale for the whole dev session.
  it('gives a transitively edited import tree a new URL', () => {
    mkdirSync(pathlib.join(dir, 'src'))
    const target = pathlib.join(dir, 'src', 'config.ts')
    const dep = pathlib.join(dir, 'src', 'constants.ts')
    writeFileSync(dep, 'export const PIN = 8\n')
    writeFileSync(target, "export {PIN} from './constants.js'\n")
    const source = `import {PIN} from './src/config.js'\n`
    const before = rewriteConfigImports(source, dir, configPath, SCHEMA_URL)
    const past = new Date(Date.now() - 60_000)
    utimesSync(target, past, past)
    utimesSync(dep, past, past)
    const rewound = rewriteConfigImports(source, dir, configPath, SCHEMA_URL)
    expect(rewound).not.toEqual(before)
    // Touch only the dependency: the direct target's mtime is unchanged.
    utimesSync(dep, new Date(), new Date())
    const after = rewriteConfigImports(source, dir, configPath, SCHEMA_URL)
    expect(after).not.toEqual(rewound)
  })
})
