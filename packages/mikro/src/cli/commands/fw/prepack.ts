import {existsSync} from 'node:fs'
import * as pathlib from 'node:path'

import {
  type BoardImage,
  type BoardProblem,
  type ConfiguredBoard,
  loadBoards,
} from '@mikrojs/firmware/boards'
import {findPackageRoot} from '@mikrojs/firmware/manifest'
import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {agentResult, isAgentMode} from '../../lib/agent.js'
import {boardProjectDir} from '../../lib/boards.js'
import {BOARDS_CONFIG, loadBoardsConfig, selectBoards} from '../../lib/boardsConfig.js'
import {displayPath} from '../../lib/displayPath.js'
import {UserError} from '../../lib/errorMessage.js'
import {boardPackageProblems, configuredImageProblems, writeImage} from '../../lib/fwImage.js'
import {buildBoard, failFw} from './shared.js'

export const args = command(
  'prepack',
  object({
    subcommand: constant('prepack' as const),
    board: optional(
      option('--board', string({metavar: 'BOARD'}), {
        description: message`Build only this board: its key in boards.config.ts (./t-display) or its name`,
      }),
    ),
  }),
  {
    description: message`Build the boards in boards.config.ts and write their images where the package's "firmware" exports point`,
  },
)

type Args = InferValue<typeof args>

/** Problems as the lines of an error message. */
export function problemLines(problems: BoardProblem[]): string {
  return problems.map((p) => `  ${p.specifier}: ${p.message}`).join('\n')
}

/**
 * The package around `dir` and the boards its boards.config.ts declares, or
 * undefined when it has no config. Throws when the config has problems.
 */
export async function configuredPackage(
  dir: string,
): Promise<{packageDir: string; boards: ConfiguredBoard[]} | undefined> {
  const packageDir = findPackageRoot(dir)
  if (packageDir === undefined) return undefined
  const loaded = await loadBoardsConfig(packageDir)
  if (loaded === undefined) return undefined
  if (loaded.problems.length > 0) {
    throw new UserError(
      `${pathlib.join(packageDir, BOARDS_CONFIG)} and package.json don't match up:\n` +
        problemLines(loaded.problems),
    )
  }
  return {packageDir, boards: loaded.boards}
}

/**
 * Build `boards`, write each image where the config puts it, and check them.
 * Undefined when a build failed (the process is exiting with its code).
 */
export async function prepackBoards(
  packageDir: string,
  boards: ConfiguredBoard[],
  commandName: string,
  jsonOutput: boolean,
): Promise<BoardImage[] | undefined> {
  for (const board of boards) {
    const buildDir = await buildBoard(packageDir, board, commandName, jsonOutput)
    if (buildDir === undefined) return undefined
    await writeImage(
      buildDir,
      board.imageDir,
      board.project ?? boardProjectDir(packageDir, board.key),
    )
  }
  const specifiers = new Set(boards.map((b) => b.specifier))
  const problems = [
    ...boardPackageProblems(packageDir),
    ...configuredImageProblems(packageDir, boards),
  ].filter((p) => specifiers.has(p.specifier))
  const images = loadBoards(packageDir).boards.filter((b) => specifiers.has(b.specifier))
  if (problems.length > 0) {
    throw new UserError(`The images in ${displayPath(packageDir)}:\n${problemLines(problems)}`)
  }
  return images
}

/** The error for a package without boards.config.ts. */
export function noBoardsConfig(dir: string): UserError {
  const packageDir = findPackageRoot(dir)
  if (packageDir === undefined) return new UserError(`No package.json at or above ${dir}.`)
  // A package from before boards.config.ts, with its firmware project at the root
  const project = existsSync(pathlib.join(packageDir, 'CMakeLists.txt'))
  return new UserError(
    `${pathlib.join(packageDir, BOARDS_CONFIG)} does not exist. A board package lists its ` +
      `boards there, for example:\n\n` +
      `  import {defineBoards} from 'mikro'\n\n` +
      `  export default defineBoards({boards: {'.': {chip: 'esp32c6'${project ? ", project: '.'" : ''}}}})` +
      (project ? '\n\n`project` builds the board from the firmware project in the package.' : ''),
  )
}

export async function run(config: Args): Promise<void> {
  const jsonOutput = isAgentMode()
  try {
    const configured = await configuredPackage(process.cwd())
    if (configured === undefined) throw noBoardsConfig(process.cwd())
    const {packageDir, boards} = configured
    const images = await prepackBoards(
      packageDir,
      selectBoards(boards, config.board),
      'fw prepack',
      jsonOutput,
    )
    if (images === undefined) return
    if (jsonOutput) {
      agentResult('fw prepack', {
        boards: images.map(({name, chip, dir}) => ({name, chip, dir})),
      })
    } else {
      for (const image of images) {
        // eslint-disable-next-line no-console
        console.log(`Wrote the image of ${image.name} (${image.chip}) to ${displayPath(image.dir)}`)
      }
    }
  } catch (err) {
    failFw('fw prepack', err, jsonOutput)
  }
}
