/* eslint-disable no-console */
import {spawnSync, type SpawnSyncReturns, type StdioOptions} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import * as pathlib from 'node:path'
import {fileURLToPath} from 'node:url'

import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {passThrough} from '@optique/core/primitives'

import {UserError} from '../lib/errorMessage.js'
import {resolveProjectRoot} from '../lib/projectRoot.js'

const EIM_DOCS = 'https://docs.espressif.com/projects/idf-im-ui/en/latest/'

export const args = command(
  'idf',
  object({
    action: constant('idf'),
    args: passThrough({format: 'greedy', description: message`Arguments for idf.py`}),
  }),
  {
    description: message`Run ESP-IDF's idf.py to build custom firmware, with the build in .mikro/build-fw (.mikro/build-fw-<folder> for a project in a folder of the package)`,
  },
)

export async function run(config: InferValue<typeof args>): Promise<void> {
  const projectDir = pathlib.resolve(optionValue(config.args, '-C', '--project-dir') ?? '')
  process.exitCode = runIdf(idfArgs(projectDir, config.args))
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

/** Where `mikro idf` builds: `.mikro/build-fw` in the package around the idf.py
 *  project, or `.mikro/build-fw-<folder>` for a project in a folder of the
 *  package (`t-display/` builds in `.mikro/build-fw-t-display`), so the boards
 *  of a multi-board package each keep a build of their own. */
export function firmwareBuildDir(projectDir: string): string {
  const root = resolveProjectRoot(projectDir)
  const folder = pathlib.relative(root, pathlib.resolve(projectDir))
  const name = folder === '' ? 'build-fw' : `build-fw-${folder.split(pathlib.sep).join('-')}`
  return pathlib.join(root, '.mikro', name)
}

/** The folder of @mikrojs/firmware's CMake package (MikroFirmwareConfig.cmake),
 *  as the firmware project in `projectDir` resolves the package: Node's
 *  resolution of `@mikrojs/firmware` under the `cmake` export condition. */
function firmwareCmakeDir(projectDir: string): string {
  const resolved = spawnSync(
    process.execPath,
    [
      '--conditions=cmake',
      '--input-type=module',
      '--eval',
      "process.stdout.write(import.meta.resolve('@mikrojs/firmware'))",
    ],
    // Resolve as plain Node does: NODE_OPTIONS (the CLI's tsx in the Mikro.js
    // repo, or the user's own) can load hooks that change the result.
    {cwd: projectDir, encoding: 'utf8', env: {...process.env, NODE_OPTIONS: undefined}},
  )
  if (resolved.status !== 0) {
    // Node names the child's --eval as the importer; leave that out
    const error = /Error \[(\w+)\]: (.*?)(?: imported from .*)?$/m.exec(resolved.stderr)
    if (error?.[1] === 'ERR_MODULE_NOT_FOUND') {
      throw new UserError(
        `@mikrojs/firmware is not installed for the firmware project in ${projectDir}. ` +
          'Add it to the dependencies in package.json, and install them.',
      )
    }
    throw new UserError(
      `Could not resolve @mikrojs/firmware for ${projectDir}: ${error?.[2] ?? resolved.stderr.trim()}`,
    )
  }
  const config = fileURLToPath(resolved.stdout)
  if (pathlib.basename(config) !== 'MikroFirmwareConfig.cmake') {
    throw new UserError(
      `The @mikrojs/firmware installed for ${projectDir} has no CMake package ` +
        '(MikroFirmwareConfig.cmake). Update @mikrojs/firmware.',
    )
  }
  return pathlib.dirname(config)
}

/** The settings @mikrojs/firmware applies to a `chip` build before a
 *  project's own (its sdkconfig.defaults and sdkconfig.defaults.<chip>), from
 *  the package the firmware project in `projectDir` resolves. */
export function firmwareDefaults(projectDir: string, chip: string): string {
  const dir = firmwareCmakeDir(projectDir)
  return ['sdkconfig.defaults', `sdkconfig.defaults.${chip}`]
    .map((name) => pathlib.join(dir, name))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
}

/** `args` for idf.py with what a firmware build needs in front: where CMake
 *  finds @mikrojs/firmware, for a folder with a CMakeLists.txt (so --help and
 *  --version still run anywhere), and `-B <firmwareBuildDir>` unless `args`
 *  name a build directory. */
export function idfArgs(projectDir: string, args: readonly string[]): string[] {
  const firmware = existsSync(pathlib.join(projectDir, 'CMakeLists.txt'))
    ? [`-DMikroFirmware_DIR=${firmwareCmakeDir(projectDir)}`]
    : []
  const buildDir =
    optionValue(args, '-B', '--build-dir') === undefined ? ['-B', firmwareBuildDir(projectDir)] : []
  return [...firmware, ...buildDir, ...args]
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
