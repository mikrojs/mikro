import {existsSync} from 'node:fs'
import * as pathlib from 'node:path'

import {
  type BoardImage,
  type BoardProblem,
  type ConfiguredBoard,
  type ConfiguredImage,
  FULL_IMAGE,
  loadBoards,
} from '@mikrojs/firmware/boards'
import {findPackageRoot} from '@mikrojs/firmware/manifest'
import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {option} from '@optique/core/primitives'
import {integer, string} from '@optique/core/valueparser'

import {agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {boardBuildDir, boardProjectDir} from '../../lib/boards.js'
import {BOARDS_CONFIG, loadBoardsConfig, selectBoards} from '../../lib/boardsConfig.js'
import {displayPath} from '../../lib/displayPath.js'
import {UserError} from '../../lib/errorMessage.js'
import {
  boardPackageProblems,
  builtImageProblems,
  checkBoardFolder,
  checkImageFolder,
  configuredImageProblems,
  writeBoardImage,
  writeBoardImages,
} from '../../lib/fwImage.js'
import {buildBoard, buildBoardLogged, failFw} from './shared.js'

export const args = command(
  'build',
  object({
    subcommand: constant('build' as const),
    board: optional(
      option('--board', string({metavar: 'BOARD'}), {
        description: message`Build only this board: its key in boards.config.ts (./t-display) or its name`,
      }),
    ),
    image: optional(
      option('--image', string({metavar: 'IMAGE'}), {
        description: message`Build only this image of each board, full or one of its "images" (no-ble), and keep the others`,
      }),
    ),
    parallel: optional(
      option('--parallel', integer({metavar: 'N', min: 1}), {
        description: message`Build up to N images at once, across boards, each with its output in a log beside its build folder`,
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
 * Build `image` of each of `boards` (`full`, or one of its `images`), write it
 * where the config puts it, and check it. Undefined when a build failed (the
 * process is exiting with its code).
 */
async function buildOneImage(
  packageDir: string,
  boards: ConfiguredBoard[],
  image: string,
  commandName: string,
  jsonOutput: boolean,
): Promise<{name: string; chip: string; dir: string}[] | undefined> {
  const jobs = boards.map((board) => {
    const configured = board.images.find((i) => i.name === image)
    if (image !== FULL_IMAGE && configured === undefined) {
      throw new UserError(
        `${board.name} has no ${image} image. Its images: ` +
          [FULL_IMAGE, ...board.images.map((i) => i.name)].join(', '),
      )
    }
    return {board, configured}
  })
  // Before any build, so a folder that is not the board's stops it at once
  for (const {board, configured} of jobs) {
    await checkImageFolder(
      board,
      image,
      boardBuildDir(packageDir, board.key, configured?.name),
      board.project ?? boardProjectDir(packageDir, board.key, configured?.name),
    )
  }
  const written: {name: string; chip: string; dir: string}[] = []
  for (const {board, configured} of jobs) {
    const buildDir = await buildBoard(packageDir, board, commandName, jsonOutput, configured)
    if (buildDir === undefined) return undefined
    const dir = await writeBoardImage(board, image, buildDir)
    written.push({name: board.name, chip: board.chip, dir})
  }
  const problems = boards.flatMap((board) => builtImageProblems(board, image))
  if (problems.length > 0) {
    throw new UserError(`The images in ${displayPath(packageDir)}:\n${problemLines(problems)}`)
  }
  return written
}

/** One of a board's other images and the folder it built in. */
interface NamedBuild {
  name: string
  buildDir: string
}

/** A board's image as one build: `image` undefined for the full image. */
interface ImageBuild {
  board: ConfiguredBoard
  image: ConfiguredImage | undefined
  buildDir: string
  log: string
  code: number
}

/** A build's name in messages: `esp32c6-generic`, `esp32c6-generic+no-ble`. */
function buildLabel(board: ConfiguredBoard, image: ConfiguredImage | undefined): string {
  return image === undefined ? board.name : `${board.name}+${image.name}`
}

/**
 * Build every image of `boards` from one queue, `jobs` at a time, each with
 * its output in a log beside its build folder, and say how each went as it
 * finishes. After a failure it starts no more builds.
 */
async function buildImagesAtOnce(
  packageDir: string,
  boards: ConfiguredBoard[],
  jsonOutput: boolean,
  jobs: number,
): Promise<ImageBuild[]> {
  // In agent mode stdout carries only the result
  const say = (line: string) =>
    // eslint-disable-next-line no-console
    jsonOutput ? process.stderr.write(`${line}\n`) : console.log(line)
  const queue = boards.flatMap((board) =>
    [undefined, ...board.images].map((image) => ({board, image})),
  )
  const workers = Math.min(jobs, queue.length)
  say(`Building ${queue.length} images, ${workers} at a time`)
  const builds: ImageBuild[] = []
  let failed = false
  const work = async () => {
    for (let job = queue.shift(); job !== undefined && !failed; job = queue.shift()) {
      const build = await buildBoardLogged(packageDir, job.board, job.image)
      const label = buildLabel(job.board, job.image)
      say(
        build.code === 0
          ? `  built ${label}`
          : `  ${label} failed with exit code ${build.code}, see ${displayPath(build.log)}`,
      )
      if (build.code !== 0) failed = true
      builds.push({...job, ...build})
    }
  }
  await Promise.all(Array.from({length: workers}, work))
  return builds
}

/** Build a board's full image, then each of its others, with idf.py's output
 *  in the terminal. Undefined when a build failed (the process is exiting
 *  with its code). */
async function buildImagesInTurn(
  packageDir: string,
  board: ConfiguredBoard,
  commandName: string,
  jsonOutput: boolean,
): Promise<{buildDir: string; imageBuilds: NamedBuild[]} | undefined> {
  const buildDir = await buildBoard(packageDir, board, commandName, jsonOutput)
  if (buildDir === undefined) return undefined
  const imageBuilds: NamedBuild[] = []
  for (const image of board.images) {
    const imageBuild = await buildBoard(packageDir, board, commandName, jsonOutput, image)
    if (imageBuild === undefined) return undefined
    imageBuilds.push({name: image.name, buildDir: imageBuild})
  }
  return {buildDir, imageBuilds}
}

/**
 * Build `boards`, write each image where the config puts it, and check them.
 * `parallel` builds the images of all of them from one queue, that many at a
 * time. Undefined when a build failed (the process is exiting with its code).
 */
export async function buildBoardImages(
  packageDir: string,
  boards: ConfiguredBoard[],
  commandName: string,
  jsonOutput: boolean,
  parallel?: number,
): Promise<BoardImage[] | undefined> {
  // Before any build, so a folder that is not the board's stops it at once
  for (const board of boards) {
    await checkBoardFolder(
      board,
      [undefined, ...board.images].map((i) => boardBuildDir(packageDir, board.key, i?.name)),
      board.project ?? boardProjectDir(packageDir, board.key),
    )
  }
  const write = (board: ConfiguredBoard, buildDir: string, imageBuilds: NamedBuild[]) =>
    writeBoardImages(board, buildDir, imageBuilds)
  if (parallel !== undefined) {
    const builds = await buildImagesAtOnce(packageDir, boards, jsonOutput, parallel)
    // Each board whose builds all succeeded, as in turn the boards before a failure
    for (const board of boards) {
      const own = builds.filter((b) => b.board === board)
      const full = own.find((b) => b.image === undefined)
      if (full === undefined || own.length !== 1 + board.images.length) continue
      if (own.some((b) => b.code !== 0)) continue
      await write(
        board,
        full.buildDir,
        own.flatMap((b) => (b.image ? [{name: b.image.name, buildDir: b.buildDir}] : [])),
      )
    }
    const failed = builds.find((b) => b.code !== 0)
    if (failed !== undefined) {
      if (jsonOutput) {
        agentError(
          commandName,
          `idf.py build of ${buildLabel(failed.board, failed.image)} exited with code ` +
            `${failed.code}, see ${failed.log}`,
        )
      }
      process.exit(failed.code)
      return undefined
    }
  } else {
    for (const board of boards) {
      const built = await buildImagesInTurn(packageDir, board, commandName, jsonOutput)
      if (built === undefined) return undefined
      await write(board, built.buildDir, built.imageBuilds)
    }
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
    const selected = selectBoards(boards, config.board)
    if (config.image !== undefined && config.parallel !== undefined) {
      throw new UserError(
        "--parallel builds each board's images at once, and --image builds one of them.",
      )
    }
    const images =
      config.image === undefined
        ? await buildBoardImages(packageDir, selected, 'fw build', jsonOutput, config.parallel)
        : await buildOneImage(packageDir, selected, config.image, 'fw build', jsonOutput)
    if (images === undefined) return
    if (jsonOutput) {
      agentResult('fw build', {
        boards: images.map(({name, chip, dir}) => ({name, chip, dir})),
      })
    } else {
      for (const image of images) {
        // eslint-disable-next-line no-console
        console.log(`Wrote the image of ${image.name} (${image.chip}) to ${displayPath(image.dir)}`)
      }
    }
  } catch (err) {
    failFw('fw build', err, jsonOutput)
  }
}
