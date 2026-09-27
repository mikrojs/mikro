/* eslint-disable no-console */
// Before `pnpm publish`: `mikro fw check`, and every generic image built with
// this very version, so images left from a local build can't ship. The release
// builds them into dist-fw/. Bypass with MIKROJS_SKIP_PREBUILD_CHECK=1 when
// publishing without them on purpose (e.g. a local pack test).
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {loadBoards} from '@mikrojs/firmware/boards'

if (process.env.MIKROJS_SKIP_PREBUILD_CHECK === '1') process.exit(0)

const packageDir = join(import.meta.dirname, '..')
const check = spawnSync(process.execPath, [join(packageDir, 'bin', 'mikrojs.js'), 'fw', 'check'], {
  stdio: 'inherit',
  cwd: packageDir,
})
if (check.status !== 0) {
  console.error('\nSet MIKROJS_SKIP_PREBUILD_CHECK=1 to publish anyway (e.g. a local pack test).')
  process.exit(check.status ?? 1)
}

const {version} = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  version: string
}
const problems = loadBoards(packageDir)
  .boards.filter((board) => board.version !== version)
  .map((board) => `${board.name}: built with ${board.version}`)

if (problems.length > 0) {
  console.error(`mikro: refusing to publish ${version} with images of another version:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nSet MIKROJS_SKIP_PREBUILD_CHECK=1 to publish anyway (e.g. a local pack test).')
  process.exit(1)
}
