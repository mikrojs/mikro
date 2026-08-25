/**
 * The sim's `native:mikro/ota_client` stub must export every name the firmware
 * module exports. ES imports resolve eagerly, so one missing name does not
 * degrade a feature — it stops `import {ota} from 'mikro/ota'` linking at all,
 * and the app never runs. That is how the whole policy surface went missing
 * from the stub when the client was ported to C++ without anything noticing.
 *
 * Compares the export names in the stub's embedded source against the ambient
 * declare block in @mikrojs/native/runtime/internal.d.ts, which is the firmware
 * contract. Names only, as with the nvs_kv parity test.
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
  const block = dts.match(/declare module 'native:mikro\/ota_client' \{([\s\S]*?)\n\}/)
  expect(block, 'native:mikro/ota_client declare block not found in internal.d.ts').not.toBeNull()
  return [...block![1]!.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]!)
}

function stubExports(): string[] {
  const stub = readFileSync(join(__dirname, '../builtins/ota-client.ts'), 'utf-8')
  const template = stub.match(/source:\s*`([\s\S]*?)`,\n/)
  expect(template, 'embedded stub source not found in ota-client.ts').not.toBeNull()
  return [...template![1]!.matchAll(/export function (\w+)/g)].map((m) => m[1]!)
}

describe('native:mikro/ota_client sim stub parity', () => {
  it('stub exports match the firmware module contract', () => {
    expect(stubExports().sort()).toEqual(declaredExports().sort())
  })

  it('covers every name the mikro/ota facade imports', () => {
    const facade = readFileSync(
      join(__dirname, '../../../..', '@mikrojs/native/runtime/ota/ota.ts'),
      'utf-8',
    )
    const block = facade.match(/import \{([^{}]*)\} from 'native:mikro\/ota_client'/)
    expect(block, 'ota.ts does not import from native:mikro/ota_client').not.toBeNull()
    const imported = block![1]!
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '')
    expect(imported.length).toBeGreaterThan(0)
    for (const name of imported) expect(stubExports()).toContain(name)
  })
})
