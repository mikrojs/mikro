// Before `pnpm publish`: the generic image of every chip is present and sound,
// and built with this version. The release builds them into dist-fw/; see
// src/boards.ts for what is checked. Bypass with MIKROJS_SKIP_PREBUILD_CHECK=1
// when publishing without them on purpose (e.g. a local pack test).
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {checkBoardPackage, loadBoards} from '../src/boards.ts'
import {chips} from '../src/index.ts'

if (process.env.MIKROJS_SKIP_PREBUILD_CHECK === '1') process.exit(0)

const packageDir = join(import.meta.dirname, '..')
const {version} = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  version: string
}

const problems = checkBoardPackage(packageDir).map((p) => `${p.specifier}: ${p.message}`)
const {boards} = loadBoards(packageDir)
for (const chip of chips) {
  const board = boards.find((b) => b.name === `${chip}-generic`)
  if (board === undefined) {
    problems.push(`no image named ${chip}-generic`)
  } else if (board.chip !== chip || board.version !== version) {
    problems.push(
      `${board.name} is a ${board.chip} image of ${board.version}, not ${chip} ${version}`,
    )
  }
}

if (problems.length > 0) {
  console.error('@mikrojs/firmware: refusing to publish:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nSet MIKROJS_SKIP_PREBUILD_CHECK=1 to publish anyway (e.g. a local pack test).')
  process.exit(1)
}
