/**
 * Verifies every native:* simulator stub returns Result objects via the
 * `ok()` / `err()` factories from `mikro/result` rather than plain
 * `{ok: true}` / `{ok: false}` literals — the factories attach the
 * `.orPanic` / `.map` / `.match` / `.orDefault` / `.andThen` / `.mapErr`
 * prototype methods that user code relies on.
 *
 * Regression: most stubs originally returned plain object literals, so
 * `pinMode(15, 'OUTPUT').orPanic('…')` failed with `TypeError: not a
 * function` because the prototype was missing.
 *
 * Static source check rather than runtime probe: instantiating MikroRuntime
 * inside vitest's forked worker is environment-fragile (the addon's
 * teardown sometimes hangs the worker), so we keep this regression in pure
 * source-grep form. It misses cases where a function imports `ok` but
 * returns a literal anyway, but that's a much narrower failure mode than
 * the one we're guarding against.
 */
import {readdirSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {describe, expect, it} from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const builtinsDir = join(__dirname, '../builtins')

interface Stub {
  file: string
  source: string
  template: string
}

/** Extract the embedded template-string source from each stub file's
 *  `BuiltinDefinition.source` property. The stubs ship as JS-source-as-data
 *  so they can be registered as virtual modules at runtime; the QuickJS-side
 *  code we want to check is inside the backtick template literal. */
function loadStubs(): Stub[] {
  const stubs: Stub[] = []
  for (const file of readdirSync(builtinsDir)) {
    if (!file.endsWith('.ts') || file === 'index.ts' || file === 'types.ts') continue
    const source = readFileSync(join(builtinsDir, file), 'utf-8')
    // The stub source is the contents of the backtick literal assigned to
    // `source:`. Grab everything between the first backtick after `source:`
    // and the matching closing backtick (followed by `,` then newline).
    const match = source.match(/source:\s*`([\s\S]*?)`,\n/)
    if (!match) continue
    stubs.push({file, source, template: match[1]!})
  }
  return stubs
}

const stubs = loadStubs()

// http.ts and ota.ts intentionally return non-Result discriminated unions:
// http's request() (`{ok: true, id, headers}`), and ota's stub mirrors the
// `native:mikro/ota` ABI (`{ok, resumeOffset/error/kind}`) that the
// runtime/ota/ota.ts wrapper converts into a Result via ok()/err(). The plain
// literal form is allowed only in these native-ABI stubs.
const exemptFiles = new Set(['http.ts', 'ota.ts'])

describe('simulator stubs use Result factories', () => {
  it('discovers stub files', () => {
    expect(stubs.length, 'no stubs found in builtins/').toBeGreaterThan(0)
  })

  for (const stub of stubs) {
    if (exemptFiles.has(stub.file)) continue

    it(`${stub.file} contains no plain {ok: true|false} literals`, () => {
      // Match `{ ok: true ` and `{ ok: false ` followed by a comma or close
      // brace. Allows whitespace and the `as const` cast.
      const literal = /\{\s*ok:\s*(?:true|false)\b/
      const found = literal.exec(stub.template)
      expect(
        found,
        `${stub.file}: found Result-shaped literal "${found?.[0]}" — use ok()/err() from 'mikro/result' instead`,
      ).toBeNull()
    })

    it(`${stub.file} imports ok or err from 'mikro/result'`, () => {
      const usesOk = /\bok\s*\(/.test(stub.template)
      const usesErr = /\berr\s*\(/.test(stub.template)
      if (!usesOk && !usesErr) return // No Result returns; nothing to import
      const importLine = /from\s+['"]mikro\/result['"]/
      expect(
        importLine.test(stub.template),
        `${stub.file}: calls ok()/err() but doesn't import them from 'mikro/result'`,
      ).toBe(true)
    })
  }

  it('http.ts is exempt but still uses ok() inside the request() Promise', () => {
    const http = stubs.find((s) => s.file === 'http.ts')
    expect(http, 'http.ts not found').toBeDefined()
    expect(/from\s+['"]mikro\/result['"]/.test(http!.template)).toBe(true)
    expect(/\bok\s*\(/.test(http!.template)).toBe(true)
  })
})
