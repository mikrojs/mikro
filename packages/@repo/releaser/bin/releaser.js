#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ts = resolve(here, 'releaser.ts')

const tsxBin = fileURLToPath(import.meta.resolve('tsx/cli'))

const r = spawnSync(process.execPath, [tsxBin, ts, ...process.argv.slice(2)], {stdio: 'inherit'})

if (r.error) {
  // eslint-disable-next-line no-console
  console.error(`releaser: failed to spawn tsx: ${r.error.message}`)
  process.exit(1)
}
process.exit(r.status ?? 1)
