#!/usr/bin/env node
// Backstop for `pnpm publish`: ensure all chip prebuilds are present before
// uploading to npm. Bypass with MIKROJS_SKIP_PREBUILD_CHECK=1 when packing
// non-release-context tarballs locally (e.g. workspace dogfooding).
import {existsSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

if (process.env.MIKROJS_SKIP_PREBUILD_CHECK === '1') {
  process.exit(0)
}

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)))
const prebuildsDir = join(pkgDir, 'prebuilds')

const {chips} = JSON.parse(readFileSync(join(pkgDir, 'chips.json'), 'utf8'))
const required = [
  'flasher_args.json',
  'bootloader/bootloader.bin',
  'partition_table/partition-table.bin',
  'mikrojs.bin',
]

const missing = []
for (const chip of chips) {
  for (const file of required) {
    const path = join(prebuildsDir, chip, file)
    if (!existsSync(path)) missing.push(`${chip}/${file}`)
  }
}

if (missing.length > 0) {
  console.error(`@mikrojs/firmware: refusing to publish, missing prebuilds:`)
  for (const m of missing) console.error(`  - ${m}`)
  console.error(`\nSet MIKROJS_SKIP_PREBUILD_CHECK=1 to bypass (e.g. local pack-test).`)
  process.exit(1)
}
