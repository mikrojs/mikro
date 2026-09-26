import * as pathlib from 'node:path'

import {firmwareExports, loadBoards} from '@mikrojs/firmware/boards'
import {findPackageRoot} from '@mikrojs/firmware/manifest'
import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import figures from 'figures'

import {agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {displayPath} from '../../lib/displayPath.js'
import {UserError} from '../../lib/errorMessage.js'
import {boardPackageProblems} from '../../lib/fwImage.js'
import {failFw} from './shared.js'

export const args = command('check', object({subcommand: constant('check' as const)}), {
  description: message`Check a board package's "firmware" exports and their images before it is published`,
})

type Args = InferValue<typeof args>

export function run(_config: Args): void {
  const jsonOutput = isAgentMode()
  try {
    const packageDir = findPackageRoot(process.cwd())
    if (packageDir === undefined)
      throw new UserError(`No package.json at or above ${process.cwd()}.`)
    const packageJson = pathlib.join(packageDir, 'package.json')
    const {entries, problems: exportProblems} = firmwareExports(packageDir)
    if (entries.length === 0 && exportProblems.length === 0) {
      throw new UserError(`${packageJson} has no export with a "firmware" condition.`)
    }

    const problems = boardPackageProblems(packageDir)
    const failing = new Set(problems.map((p) => p.specifier))
    const boards = loadBoards(packageDir).boards.filter((b) => !failing.has(b.specifier))
    if (jsonOutput) {
      if (problems.length > 0) {
        agentError('fw check', problems.map((p) => `${p.specifier}: ${p.message}`).join('\n'))
        process.exit(1)
        return
      }
      agentResult('fw check', {
        boards: boards.map(({name, chip, version, specifier}) => ({
          name,
          chip,
          version,
          specifier,
        })),
      })
      return
    }
    for (const board of boards) {
      // eslint-disable-next-line no-console
      console.log(
        `${figures.tick} ${board.specifier}: ${board.name} (${board.chip}, ${board.version}) ` +
          `in ${displayPath(board.dir)}`,
      )
    }
    for (const problem of problems) {
      // eslint-disable-next-line no-console
      console.error(`${figures.cross} ${problem.specifier}: ${problem.message}`)
    }
    if (problems.length > 0) process.exit(1)
  } catch (err) {
    failFw('fw check', err, jsonOutput)
  }
}
