import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

/* The dev `exports` map and `publishConfig.exports` are maintained by hand,
 * and publish replaces the map wholesale: a subpath added only to the dev map
 * works in every in-repo check and then throws ERR_PACKAGE_PATH_NOT_EXPORTED
 * for every npm consumer. No in-repo import can catch that, so compare the
 * maps directly. */
describe('package exports', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
    exports: Record<string, unknown>
    publishConfig: {exports: Record<string, string>}
  }

  it('publishConfig.exports covers exactly the dev subpaths', () => {
    expect(Object.keys(pkg.publishConfig.exports).sort()).toEqual(Object.keys(pkg.exports).sort())
  })

  it('conditional dev entries publish a compiled dist target', () => {
    // A conditional entry means the .ts source only resolves under the
    // workspace's "development" condition; the published package must point
    // at compiled output instead (Node refuses to type-strip .ts under a
    // real node_modules).
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      if (typeof entry !== 'object' || entry === null) continue
      if (subpath === '.') continue
      expect(pkg.publishConfig.exports[subpath], subpath).toMatch(/^\.\/dist\//)
    }
  })
})
