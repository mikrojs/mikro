import {execFileSync} from 'node:child_process'
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {afterAll, describe, expect, it} from 'vitest'

const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))

/* The tsconfig/ presets are committed (so the published package and in-repo
 * extends both work from a plain checkout) but generated from modules.json +
 * chips.json. Guard against the committed files drifting from the emitter. */
describe('tsconfig presets', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'mikro-tsconfig-presets-'))
  execFileSync(process.execPath, [join(pkgRoot, 'scripts/emit-tsconfig-presets.js'), outDir])

  afterAll(() => {
    rmSync(outDir, {recursive: true, force: true})
  })

  it('committed preset files match the emitter output', () => {
    const emitted = readdirSync(outDir).sort()
    expect(readdirSync(join(pkgRoot, 'tsconfig')).sort()).toEqual(emitted)
    for (const name of emitted) {
      expect(readFileSync(join(pkgRoot, 'tsconfig', name), 'utf-8'), name).toBe(
        readFileSync(join(outDir, name), 'utf-8'),
      )
    }
  })

  it('every preset is exported from package.json', () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as {
      exports: Record<string, unknown>
    }
    for (const name of readdirSync(outDir)) {
      // default.json is the bare mikro/tsconfig.
      const subpath =
        name === 'default.json' ? './tsconfig' : `./tsconfig/${name.replace(/\.json$/, '')}`
      expect(pkg.exports[subpath], subpath).toBe(`./tsconfig/${name}`)
    }
  })
})
