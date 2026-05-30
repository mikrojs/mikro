/* eslint-disable no-console */
import {existsSync, rmSync} from 'node:fs'
import * as pathlib from 'node:path'
import * as readline from 'node:readline/promises'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag} from '@optique/core/primitives'
import figures from 'figures'

import {getMikroDir} from '../../lib/projectRoot.js'
import {checkPid, SimAlreadyRunningError} from '../../lib/simPid.js'

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`

export const args = command(
  'reset',
  object({
    subcommand: constant('reset' as const),
    yes: optional(flag('-y', '--yes', {description: message`Skip confirmation prompt`})),
  }),
  {
    description: message`Erase the entire simulator state (filesystem + environment variables)`,
  },
)

export async function run(config: {yes?: boolean}): Promise<void> {
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

  if (config.yes !== true) {
    if (!process.stdin.isTTY) {
      console.error(red('Error: refusing to reset without confirmation. Pass -y to skip.'))
      process.exit(1)
    }
    const rl = readline.createInterface({input: process.stdin, output: process.stderr})
    try {
      console.error(
        `${yellow(figures.warning)} This will erase the simulator filesystem and environment variables.`,
      )
      const answer = await rl.question('Continue? (y/N) ')
      if (answer.toLowerCase() !== 'y') return
    } finally {
      rl.close()
    }
  }

  const simFs = pathlib.join(mikroDir, 'sim-fs')
  const nvsJson = pathlib.join(mikroDir, 'nvs.json')
  const deployEnv = pathlib.join(mikroDir, 'deploy-env.json')
  if (existsSync(simFs)) rmSync(simFs, {recursive: true, force: true})
  if (existsSync(nvsJson)) rmSync(nvsJson, {force: true})
  if (existsSync(deployEnv)) rmSync(deployEnv, {force: true})

  console.error(`${green(figures.tick)} Simulator reset`)
}
