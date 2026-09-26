/* eslint-disable no-console */
import {spawnSync, type SpawnSyncReturns, type StdioOptions} from 'node:child_process'
import * as pathlib from 'node:path'

import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {passThrough} from '@optique/core/primitives'

import {resolveProjectRoot} from '../lib/projectRoot.js'

const EIM_DOCS = 'https://docs.espressif.com/projects/idf-im-ui/en/latest/'

export const args = command(
  'idf',
  object({
    action: constant('idf'),
    args: passThrough({format: 'greedy', description: message`Arguments for idf.py`}),
  }),
  {
    description: message`Run ESP-IDF's idf.py to build custom firmware, with the build in .mikro/build-fw`,
  },
)

export function run(config: InferValue<typeof args>): void {
  process.exitCode = runIdf(withBuildDir(config.args))
}

/** The value of an idf.py option in any form it accepts (`-B dir`, `-Bdir`,
 * `--build-dir dir`, `--build-dir=dir`), or undefined when it is absent. */
function optionValue(args: readonly string[], short: string, long: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === short || arg === long) return args[i + 1] ?? ''
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1)
    if (arg.startsWith(short)) return arg.slice(short.length)
  }
  return undefined
}

/** Where `mikro idf` builds: `.mikro/build-fw` in the package around the idf.py project. */
export function firmwareBuildDir(projectDir: string): string {
  return pathlib.join(resolveProjectRoot(projectDir), '.mikro', 'build-fw')
}

/** `args` with `-B <firmwareBuildDir>` in front, unless they name a build directory. */
function withBuildDir(args: readonly string[]): readonly string[] {
  if (optionValue(args, '-B', '--build-dir') !== undefined) return args
  const projectDir = pathlib.resolve(optionValue(args, '-C', '--project-dir') ?? '')
  return ['-B', firmwareBuildDir(projectDir), ...args]
}

/** A word for the shell that `eim run` passes its command to. */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

function notFound(result: SpawnSyncReturns<Buffer>): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function exitCode(result: SpawnSyncReturns<Buffer>): number {
  if (!result.error) return result.status ?? 1
  console.error('Error: idf.py could not be run:', result.error)
  return 1
}

/** Runs idf.py directly when ESP-IDF is active in the shell (idf.py on PATH),
 * otherwise through EIM's `eim run`, which activates ESP-IDF first. */
export function runIdf(args: readonly string[], stdio: StdioOptions = 'inherit'): number {
  const direct = spawnSync('idf.py', args, {stdio})
  if (!notFound(direct)) return exitCode(direct)
  // idf.py must stay unquoted: in EIM's shell it is an alias, and a quoted alias does not expand.
  const viaEim = spawnSync('eim', ['run', ['idf.py', ...args.map(shellQuote)].join(' ')], {stdio})
  if (notFound(viaEim)) {
    console.error(
      `Error: idf.py is not on PATH, and EIM is not installed. Activate ESP-IDF in the shell, or install it with EIM: ${EIM_DOCS}`,
    )
    return 1
  }
  return exitCode(viaEim)
}
