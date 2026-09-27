import {closeSync, openSync} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import * as path from 'node:path'

import type {ConfiguredBoard, ConfiguredImage} from '@mikrojs/firmware/boards'

import {agentError} from '../../lib/agent.js'
import {boardBuildDir} from '../../lib/boards.js'
import {boardBuildArgs, writeBoardProject} from '../../lib/boardsConfig.js'
import {describeError, UserError} from '../../lib/errorMessage.js'
import {firmwareBuildDir, firmwareDefaults, idfArgs, runIdf, runIdfAsync} from '../idf.js'

/** Build the firmware project in `projectDir` where `mikro idf` builds it,
 *  and return that directory; undefined when idf.py failed and the process is
 *  exiting with its code. In agent mode stdout carries only the result, so
 *  idf.py's output goes to stderr. */
export function buildFirmware(
  projectDir: string,
  command: string,
  jsonOutput: boolean,
): string | undefined {
  const buildDir = firmwareBuildDir(projectDir)
  const code = runIdf(
    idfArgs(projectDir, ['-B', buildDir, 'build']),
    jsonOutput ? ['inherit', 2, 2] : 'inherit',
  )
  if (code !== 0) {
    // idf.py, or runIdf when it found neither idf.py nor eim, has said what went wrong.
    if (jsonOutput) agentError(command, `idf.py build exited with code ${code}`)
    process.exit(code)
    return undefined
  }
  return buildDir
}

/** Build a board from boards.config.ts, or one of its images, from the
 *  firmware project generated for it (or the board's own), and return its
 *  build folder; undefined when idf.py failed and the process is exiting with
 *  its code. */
export async function buildBoard(
  packageDir: string,
  board: ConfiguredBoard,
  command: string,
  jsonOutput: boolean,
  image?: ConfiguredImage,
): Promise<string | undefined> {
  const projectDir =
    board.project ??
    (await writeBoardProject(packageDir, board, image, firmwareDefaults(packageDir, board.chip)))
  const code = runIdf(
    idfArgs(projectDir, boardBuildArgs(packageDir, board, projectDir, image)),
    jsonOutput ? ['inherit', 2, 2] : 'inherit',
  )
  if (code !== 0) {
    const what = image ? `${board.name}+${image.name}` : board.name
    if (jsonOutput) agentError(command, `idf.py build of ${what} exited with code ${code}`)
    process.exit(code)
    return undefined
  }
  return boardBuildDir(packageDir, board.key, image?.name)
}

/** Build a board or one of its images like buildBoard, with idf.py's output
 *  in a log beside the build folder (`.mikro/build-fw+no-ble.log`) instead of
 *  the terminal, so several can build at once. */
export async function buildBoardLogged(
  packageDir: string,
  board: ConfiguredBoard,
  image: ConfiguredImage | undefined,
): Promise<{buildDir: string; log: string; code: number}> {
  const projectDir =
    board.project ??
    (await writeBoardProject(packageDir, board, image, firmwareDefaults(packageDir, board.chip)))
  const buildDir = boardBuildDir(packageDir, board.key, image?.name)
  const log = `${buildDir}.log`
  await mkdir(path.dirname(log), {recursive: true})
  const fd = openSync(log, 'w')
  try {
    const code = await runIdfAsync(
      idfArgs(projectDir, boardBuildArgs(packageDir, board, projectDir, image)),
      ['ignore', fd, fd],
    )
    return {buildDir, log, code}
  } finally {
    closeSync(fd)
  }
}

/** Report a failed `mikro fw` command and exit with 1. */
export function failFw(command: string, err: unknown, jsonOutput: boolean): void {
  if (jsonOutput) {
    agentError(command, describeError(err))
  } else if (err instanceof UserError) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${describeError(err)}`)
  } else {
    // eslint-disable-next-line no-console
    console.error('Error:', err)
  }
  process.exit(1)
}
