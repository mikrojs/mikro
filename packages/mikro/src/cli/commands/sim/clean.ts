/* eslint-disable no-console */
import {existsSync, rmSync} from 'node:fs'
import * as pathlib from 'node:path'

import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import figures from 'figures'

import {getMikroDir} from '../../lib/projectRoot.js'
import {checkPid, SimAlreadyRunningError} from '../../lib/simPid.js'

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`

export const args = command(
  'clean',
  object({
    subcommand: constant('clean' as const),
  }),
  {description: message`Remove the deployed app from the simulator`},
)

export function run(): void {
  const mikroDir = getMikroDir()
  try {
    checkPid(mikroDir)
  } catch (err) {
    if (err instanceof SimAlreadyRunningError) {
      console.error(`${red(figures.cross)} ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  const appDir = pathlib.join(mikroDir, 'sim-fs', 'app')
  if (existsSync(appDir)) rmSync(appDir, {recursive: true, force: true})

  const checksums = pathlib.join(mikroDir, 'sim-fs', '.checksums')
  if (existsSync(checksums)) rmSync(checksums, {force: true})

  console.error(`${green(figures.tick)} Removed deployed app`)
}
