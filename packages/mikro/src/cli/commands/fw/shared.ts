import {spawnSync} from 'node:child_process'
import {closeSync, openSync} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import * as path from 'node:path'

import {type ConfiguredBoard, type ConfiguredImage, FULL_IMAGE} from '@mikrojs/firmware/boards'
import {SerialPort} from 'serialport'

import {agentError, isAgentMode} from '../../lib/agent.js'
import {boardBuildDir} from '../../lib/boards.js'
import {boardBuildArgs, writeBoardProject} from '../../lib/boardsConfig.js'
import {getCachedChip} from '../../lib/deviceCache.js'
import {describeError, UserError} from '../../lib/errorMessage.js'
import {pickOne} from '../../lib/pickOne.js'
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

/** Flash an image `mikro fw build` wrote by running `mikro flash` in its
 *  package, which picks it by its features, so it flashes as any image of the
 *  board does: fitted to the device's flash, with that command's prompts and
 *  checks. Returns its exit code. */
export function flashBuiltImage(packageDir: string, board: string, features: string): number {
  const cli = process.argv[1]!
  const flash = spawnSync(
    process.execPath,
    [cli, 'flash', '--board', board, '--features', features],
    {stdio: 'inherit', cwd: packageDir},
  )
  return flash.status ?? 1
}

/** The key of a board of `boards`, asked for in the terminal for a bare
 *  `--board`. Without a terminal, an error that lists them. */
export async function pickBoard(
  boards: {key: string; name: string; chip: string}[],
): Promise<string> {
  if (!process.stdin.isTTY || isAgentMode()) {
    throw new UserError(
      '--board needs a board. The boards in boards.config.ts:\n' +
        boards.map((b) => `  ${b.name} (${b.chip})`).join('\n'),
    )
  }
  if (boards.length === 1) return boards[0]!.key
  // The boards for a connected chip first, marked
  const connected = await connectedChips()
  const ordered = [
    ...boards.filter((b) => connected.has(b.chip)),
    ...boards.filter((b) => !connected.has(b.chip)),
  ]
  return pickOne(
    'Which board?',
    ordered.map((b) => ({
      label: `${b.name} (${b.chip})${connected.has(b.chip) ? '  connected' : ''}`,
      value: b.key,
    })),
  )
}

/** An image of each of `boards` (`full`, or one they all have), asked for in
 *  the terminal for a bare `--image`. Without a terminal, an error that lists
 *  them. */
export async function pickImage(boards: ConfiguredBoard[]): Promise<string> {
  const names = [FULL_IMAGE, ...(boards[0]?.images ?? []).map((i) => i.name)].filter(
    (name) => name === FULL_IMAGE || boards.every((b) => b.images.some((i) => i.name === name)),
  )
  if (!process.stdin.isTTY || isAgentMode()) {
    const whose = boards.length === 1 ? `of ${boards[0]!.name}` : 'all the boards have'
    throw new UserError(`--image needs an image. The images ${whose}: ${names.join(', ')}`)
  }
  if (names.length === 1) return names[0]!
  return pickOne(
    'Which image?',
    names.map((name) => ({label: name, value: name})),
  )
}

/** The chips of the connected devices, as `mikro ls` shows them: from the
 *  device cache, so a device the CLI has not talked to yet has none. */
async function connectedChips(): Promise<Set<string>> {
  const ports = await SerialPort.list()
  return new Set(
    ports.flatMap((p) => {
      const chip = p.serialNumber === undefined ? undefined : getCachedChip(p.serialNumber)
      return chip === undefined ? [] : [chip]
    }),
  )
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
