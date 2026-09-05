import {existsSync, readdirSync, readFileSync} from 'node:fs'
import * as pathlib from 'node:path'

import {expect, test} from 'vitest'

const here = import.meta.dirname
const root = pathlib.resolve(here, '../../..')
const testDir = pathlib.join(here, '../test')

// Entries in the `mikro` exports map that are not importable device modules,
// or that the harness itself keeps resident so their import cost cannot be
// observed from inside a test file.
const NOT_CENSUSED = new Set([
  './package.json',
  './tsconfig',
  './runtime', // host-side build entry
  './sim', // host-side simulator stubs
  './console', // type-only shim; console is a global
  './format', // type-only shim
  './sys', // imported by mikro/test, so already loaded in the baseline
  './test', // the harness
])

function censusFile(specifier: string): string {
  return `${specifier.replace(/^\.\//, '').replaceAll('/', '-')}.test.ts`
}

const pkg = JSON.parse(readFileSync(pathlib.join(root, 'packages/mikro/package.json'), 'utf-8'))
const specifiers = Object.keys(pkg.exports).filter((k) => k !== '.' && !NOT_CENSUSED.has(k))

test('every public builtin has a census file', () => {
  const missing = specifiers.filter((s) => !existsSync(pathlib.join(testDir, censusFile(s))))
  expect(missing, 'add test/<name>.test.ts for each').toEqual([])
})

test('every census file is a public builtin', () => {
  const expected = new Set([...specifiers.map(censusFile), '_baseline.test.ts'])
  const extra = readdirSync(testDir).filter((f) => !expected.has(f))
  expect(extra, 'remove, or add the export to packages/mikro').toEqual([])
})
