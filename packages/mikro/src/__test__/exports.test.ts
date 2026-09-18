import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

import {builtinModules, isTypesOnlyModule} from '../cli/lib/capabilities.js'

type ExportEntry = string | {[condition: string]: ExportEntry}

/* The dev `exports` map and `publishConfig.exports` are maintained by hand,
 * and publish replaces the map wholesale: a subpath added or gated only in the
 * dev map works in every in-repo check and then behaves differently for every
 * npm consumer. No in-repo import can catch that, so compare the maps
 * directly. */
describe('package exports', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
    exports: Record<string, ExportEntry>
    publishConfig: {exports: Record<string, ExportEntry>}
  }

  const featureConditions = (entry: ExportEntry) =>
    typeof entry === 'string' ? [] : Object.keys(entry).filter((key) => key.startsWith('mikro:'))

  it('publishConfig.exports covers exactly the dev subpaths', () => {
    expect(Object.keys(pkg.publishConfig.exports).sort()).toEqual(Object.keys(pkg.exports).sort())
  })

  it('feature-gated subpaths gate the published entry behind the same conditions', () => {
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      const conditions = featureConditions(entry)
      expect(featureConditions(pkg.publishConfig.exports[subpath]!), subpath).toEqual(conditions)
      if (conditions.length === 0) continue
      // A gated entry must resolve under its feature condition alone; a
      // fallback branch would silently ungate the subpath.
      expect(Object.keys(entry), subpath).toEqual(conditions)
      expect(Object.keys(pkg.publishConfig.exports[subpath]!), subpath).toEqual(conditions)
    }
  })

  it('every module subpath is a table builtin or a types-only subpath', () => {
    // The build rejects any other mikro/<name> import as unknown, so an export
    // added without a table entry would be importable in the editor only.
    const hostOnly = (subpath: string) =>
      ['.', './package.json', './runtime', './tsconfig'].includes(subpath) ||
      subpath.startsWith('./tsconfig/')
    const names = Object.keys(pkg.exports)
      .filter((subpath) => !hostOnly(subpath))
      .map((subpath) => subpath.slice('./'.length))
    const builtins = builtinModules()
    expect(names.filter((name) => !builtins.has(name) && !isTypesOnlyModule(name))).toEqual([])
    expect(names.filter((name) => builtins.has(name) && isTypesOnlyModule(name))).toEqual([])
  })

  it('conditional dev entries publish a compiled dist target', () => {
    // A conditional entry means the .ts source only resolves under the
    // workspace's "development" condition; the published package must point
    // at compiled output instead (Node refuses to type-strip .ts under a
    // real node_modules).
    const leaf = (entry: ExportEntry): string => {
      if (typeof entry === 'string') return entry
      const values = Object.values(entry)
      expect(values).toHaveLength(1)
      return leaf(values[0]!)
    }
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      if (typeof entry !== 'object' || entry === null) continue
      if (subpath === '.') continue
      expect(leaf(pkg.publishConfig.exports[subpath]!), subpath).toMatch(/^\.\/dist\//)
    }
  })
})
