import * as pathlib from 'node:path'

import {firmwareExports, loadBoards} from '@mikrojs/firmware/boards'
import {findPackageRoot} from '@mikrojs/firmware/manifest'
import type {InferValue} from '@optique/core/parser'
import figures from 'figures'

import {agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {loadBoardsConfig} from '../../lib/boardsConfig.js'
import {displayPath} from '../../lib/displayPath.js'
import {UserError} from '../../lib/errorMessage.js'
import {
  boardPackageProblems,
  configuredImageProblems,
  genericBoardProblems,
} from '../../lib/fwImage.js'
import type {args} from './check.args.js'
import {failFw} from './shared.js'

type Args = InferValue<typeof args>

export async function run(_config: Args): Promise<void> {
  const jsonOutput = isAgentMode()
  try {
    const packageDir = findPackageRoot(process.cwd())
    if (packageDir === undefined)
      throw new UserError(`No package.json at or above ${process.cwd()}.`)
    const packageJson = pathlib.join(packageDir, 'package.json')
    const config = await loadBoardsConfig(packageDir)
    const {entries, problems: exportProblems} = firmwareExports(packageDir)
    if (config === undefined && entries.length === 0 && exportProblems.length === 0) {
      throw new UserError(`${packageJson} has no export with a "firmware" condition.`)
    }

    const problems = [
      ...(config?.problems ?? []),
      ...boardPackageProblems(packageDir),
      ...(config === undefined
        ? []
        : [
            ...configuredImageProblems(packageDir, config.boards),
            ...genericBoardProblems(packageDir, config.boards, config.generic),
          ]),
    ]
    const failing = new Set(problems.map((p) => p.specifier))
    const loaded = loadBoards(packageDir)
    const boards = loaded.boards.filter((b) => !failing.has(b.specifier))
    const generic = loaded.generic.filter((b) => !failing.has(b.specifier))
    if (jsonOutput) {
      if (problems.length > 0) {
        agentError('fw check', problems.map((p) => `${p.specifier}: ${p.message}`).join('\n'))
        process.exit(1)
        return
      }
      agentResult('fw check', {
        boards: [
          ...boards.map(({name, chip, version, specifier}) => ({name, chip, version, specifier})),
          ...generic.map(({name, firmware, specifier}) => ({name, firmware, specifier})),
        ],
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
    for (const board of generic) {
      // eslint-disable-next-line no-console
      console.log(`${figures.tick} ${board.specifier}: ${board.name} runs ${board.firmware}`)
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
