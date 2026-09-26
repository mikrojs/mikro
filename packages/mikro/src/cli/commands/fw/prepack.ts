import * as pathlib from 'node:path'

import {type BoardImage, loadBoards} from '@mikrojs/firmware/boards'
import {findPackageRoot} from '@mikrojs/firmware/manifest'
import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'

import {agentResult, isAgentMode} from '../../lib/agent.js'
import {displayPath} from '../../lib/displayPath.js'
import {UserError} from '../../lib/errorMessage.js'
import {
  boardPackageProblems,
  ownBoardExport,
  suggestedExport,
  writeImage,
} from '../../lib/fwImage.js'
import {buildFirmware, failFw} from './shared.js'

export const args = command('prepack', object({subcommand: constant('prepack' as const)}), {
  description: message`Build a board's firmware and write its image where the package's "firmware" export points`,
})

type Args = InferValue<typeof args>

/**
 * Build the board firmware project in `projectDir`, write its image into the
 * folder of the package export that points at the project's image, and check it.
 * Undefined when the build failed (the process is exiting with its code).
 */
export async function prepackBoard(
  projectDir: string,
  commandName: string,
  jsonOutput: boolean,
): Promise<BoardImage | undefined> {
  const own = ownBoardExport(projectDir)
  if (own === undefined) {
    const packageDir = findPackageRoot(projectDir)
    throw new UserError(
      packageDir === undefined
        ? `No package.json at or above ${projectDir}.`
        : `No export in ${pathlib.join(packageDir, 'package.json')} has a "firmware" condition ` +
            `for the image of ${projectDir}. Add one to "exports", for example:\n` +
            `  ${suggestedExport(packageDir, projectDir)}`,
    )
  }
  const built = buildFirmware(projectDir, commandName, jsonOutput)
  if (built === undefined) return undefined
  const imageDir = pathlib.dirname(own.entry.file)
  await writeImage(built, imageDir, projectDir)

  const {specifier} = own.entry
  const problems = boardPackageProblems(own.packageDir).filter((p) => p.specifier === specifier)
  const board = loadBoards(own.packageDir).boards.find((b) => b.specifier === specifier)
  if (board === undefined || problems.length > 0) {
    throw new UserError(
      `The image of ${specifier} in ${displayPath(imageDir)}:\n` +
        problems.map((p) => `  ${p.message}`).join('\n'),
    )
  }
  return board
}

export async function run(_config: Args): Promise<void> {
  const jsonOutput = isAgentMode()
  try {
    const board = await prepackBoard(process.cwd(), 'fw prepack', jsonOutput)
    if (board === undefined) return
    if (jsonOutput) {
      agentResult('fw prepack', {name: board.name, chip: board.chip, dir: board.dir})
    } else {
      // eslint-disable-next-line no-console
      console.log(`Wrote the image of ${board.name} (${board.chip}) to ${displayPath(board.dir)}`)
    }
  } catch (err) {
    failFw('fw prepack', err, jsonOutput)
  }
}
