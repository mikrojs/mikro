/**
 * The sim's `native:mikro/nvs_kv` stub must mirror the firmware module's
 * export surface exactly (the sim exists to mirror firmware behavior).
 * Compares the export names in the stub's embedded source against the
 * ambient declare block in @mikrojs/native/runtime/internal.d.ts, which is
 * the firmware contract. Catches drift when one side gains an export the
 * other doesn't.
 *
 * Scope: names only. The stub source runs inside the QuickJS subprocess, so
 * behavioral kv/sys isolation is covered by the opt-in SIM_SMOKE scenario in
 * simDevSmoke.test.ts and by the on-device [kv] tests, not here.
 */
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {describe, expect, it} from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))

function declaredExports(): string[] {
  const dts = readFileSync(
    join(__dirname, '../../../..', '@mikrojs/native/runtime/internal.d.ts'),
    'utf-8',
  )
  const block = dts.match(/declare module 'native:mikro\/nvs_kv' \{([\s\S]*?)\n\}/)
  expect(block, 'native:mikro/nvs_kv declare block not found in internal.d.ts').not.toBeNull()
  return [...block![1]!.matchAll(/export function (\w+)/g)].map((m) => m[1]!)
}

function stubExports(): string[] {
  const stub = readFileSync(join(__dirname, '../builtins/nvs-kv.ts'), 'utf-8')
  const template = stub.match(/source:\s*`([\s\S]*?)`,\n/)
  expect(template, 'embedded stub source not found in nvs-kv.ts').not.toBeNull()
  return [...template![1]!.matchAll(/export function (\w+)/g)].map((m) => m[1]!)
}

describe('native:mikro/nvs_kv sim stub parity', () => {
  it('stub exports match the firmware module contract', () => {
    expect(stubExports().sort()).toEqual(declaredExports().sort())
  })
})
