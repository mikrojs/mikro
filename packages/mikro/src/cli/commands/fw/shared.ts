import type {ConfiguredBoard} from '@mikrojs/firmware/boards'

import {agentError} from '../../lib/agent.js'
import {boardBuildDir} from '../../lib/boards.js'
import {boardBuildArgs, writeBoardProject} from '../../lib/boardsConfig.js'
import {describeError, UserError} from '../../lib/errorMessage.js'
import {firmwareBuildDir, firmwareDefaults, idfArgs, runIdf} from '../idf.js'

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

/** Build a board from boards.config.ts, from the firmware project generated
 *  for it or its own, and return its build folder; undefined when idf.py
 *  failed and the process is exiting with its code. */
export async function buildBoard(
  packageDir: string,
  board: ConfiguredBoard,
  command: string,
  jsonOutput: boolean,
): Promise<string | undefined> {
  const projectDir =
    board.project ??
    (await writeBoardProject(packageDir, board, firmwareDefaults(packageDir, board.chip)))
  const code = runIdf(
    idfArgs(projectDir, boardBuildArgs(packageDir, board, projectDir)),
    jsonOutput ? ['inherit', 2, 2] : 'inherit',
  )
  if (code !== 0) {
    if (jsonOutput) agentError(command, `idf.py build of ${board.name} exited with code ${code}`)
    process.exit(code)
    return undefined
  }
  return boardBuildDir(packageDir, board.key)
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
