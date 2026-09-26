import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {run} from '../idf.js'

/* `mikro idf` against a fake idf.py and a fake eim on a controlled PATH. */

const root = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'mikro-idf-')))
const argsFile = pathlib.join(root, 'args.txt')

function write(file: string, content: string) {
  mkdirSync(pathlib.dirname(file), {recursive: true})
  writeFileSync(file, content)
}

function script(file: string, body: string) {
  write(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

/** A fake idf.py: writes each argument on a line of its own, exits with 3. */
const idfDir = pathlib.join(root, 'idf')
script(pathlib.join(idfDir, 'idf.py'), `printf '%s\\n' "$@" > "${argsFile}"\nexit 3`)

/** A fake eim: `eim run <command>` runs the command in a shell that has idf.py. */
const eimDir = pathlib.join(root, 'eim')
script(
  pathlib.join(eimDir, 'eim'),
  `[ "$1" = run ] || exit 9\nPATH="${idfDir}:$PATH" exec /bin/sh -c "$2"`,
)

/** @mikrojs/firmware installed in `dir`, with `exports`; returns the folder of
 *  its CMake package. */
function installFirmware(
  dir: string,
  exports: unknown = {'.': {cmake: './MikroFirmwareConfig.cmake', import: './dist/index.js'}},
) {
  const packageDir = pathlib.join(dir, 'node_modules', '@mikrojs', 'firmware')
  write(
    pathlib.join(packageDir, 'package.json'),
    JSON.stringify({name: '@mikrojs/firmware', type: 'module', exports}),
  )
  write(pathlib.join(packageDir, 'MikroFirmwareConfig.cmake'), '')
  return packageDir
}

/** An app that is its own firmware project, and one with the firmware in a folder. */
const app = pathlib.join(root, 'app')
write(pathlib.join(app, 'package.json'), '{}')
write(pathlib.join(app, 'CMakeLists.txt'), '')
const appFirmwareDefine = `-DMikroFirmware_DIR=${installFirmware(app)}`
const appWithFolder = pathlib.join(root, 'app-with-folder')
const firmwareFolder = pathlib.join(appWithFolder, 'firmware')
write(pathlib.join(appWithFolder, 'package.json'), '{}')
write(pathlib.join(firmwareFolder, 'CMakeLists.txt'), '')
const folderFirmwareDefine = `-DMikroFirmware_DIR=${installFirmware(appWithFolder)}`

const originalCwd = process.cwd()

async function idf(args: string[], pathDirs: string[] = [idfDir, eimDir]) {
  vi.stubEnv('PATH', [...pathDirs, '/usr/bin', '/bin'].join(':'))
  rmSync(argsFile, {force: true})
  await run({action: 'idf', args})
  return {
    args: readFileSync(argsFile, 'utf8').split('\n').slice(0, -1),
    exitCode: process.exitCode,
  }
}

beforeEach(() => {
  process.chdir(app)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.chdir(originalCwd)
  process.exitCode = undefined
})

afterAll(() => {
  rmSync(root, {recursive: true, force: true})
})

// Quotes, spaces and ; must reach idf.py unchanged, also through eim's shell.
const tricky = ['-DMIKROJS_NATIVE_MODULES=@a/x;@b/y', 'build', "it's", 'two words', '$HOME']
const appBuildDir = pathlib.join(app, '.mikro', 'build-fw')

describe('mikro idf', () => {
  it('runs idf.py directly when it is on PATH, and exits with its code', async () => {
    expect(await idf(tricky)).toEqual({
      args: [appFirmwareDefine, '-B', appBuildDir, ...tricky],
      exitCode: 3,
    })
  })

  it('runs idf.py through eim when idf.py is not on PATH', async () => {
    expect(await idf(tricky, [eimDir])).toEqual({
      args: [appFirmwareDefine, '-B', appBuildDir, ...tricky],
      exitCode: 3,
    })
  })

  it('says what to do when neither idf.py nor eim is installed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('PATH', '/usr/bin:/bin')
    await run({action: 'idf', args: ['build']})
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('idf.py is not on PATH, and EIM is not installed'),
    )
    expect(process.exitCode).toBe(1)
  })

  it('leaves a build directory given in the arguments alone', async () => {
    for (const args of [
      ['-B', 'out', 'build'],
      ['-Bout', 'build'],
      ['--build-dir', 'out', 'build'],
      ['--build-dir=out', 'build'],
    ]) {
      expect((await idf(args)).args).toEqual([appFirmwareDefine, ...args])
    }
  })

  it('builds in .mikro of the app, named after the folder, when the firmware project is a folder in it', async () => {
    process.chdir(firmwareFolder)
    const buildDir = pathlib.join(appWithFolder, '.mikro', 'build-fw-firmware')
    expect((await idf(['build'])).args).toEqual([folderFirmwareDefine, '-B', buildDir, 'build'])
  })

  it('finds the project from -C', async () => {
    process.chdir(root)
    const buildDir = pathlib.join(appWithFolder, '.mikro', 'build-fw-firmware')
    for (const args of [
      ['-C', 'app-with-folder/firmware', 'build'],
      ['--project-dir=app-with-folder/firmware', 'build'],
    ]) {
      expect((await idf(args)).args).toEqual([folderFirmwareDefine, '-B', buildDir, ...args])
    }
  })

  it('stops when the project has no @mikrojs/firmware with a CMake package', async () => {
    const bare = pathlib.join(root, 'bare')
    write(pathlib.join(bare, 'package.json'), '{}')
    write(pathlib.join(bare, 'CMakeLists.txt'), '')
    process.chdir(bare)
    await expect(run({action: 'idf', args: ['build']})).rejects.toThrow(
      `@mikrojs/firmware is not installed for the firmware project in ${bare}. ` +
        'Add it to the dependencies in package.json, and install them.',
    )

    const old = pathlib.join(root, 'old')
    write(pathlib.join(old, 'package.json'), '{}')
    write(pathlib.join(old, 'CMakeLists.txt'), '')
    installFirmware(old, {'.': {import: './dist/index.js'}})
    process.chdir(old)
    await expect(run({action: 'idf', args: ['build']})).rejects.toThrow(
      /installed for .*\/old has no CMake package \(MikroFirmwareConfig\.cmake\)\. Update @mikrojs\/firmware\./,
    )
  })

  it('runs idf.py without the package outside a firmware project, so --version works anywhere', async () => {
    const elsewhere = pathlib.join(root, 'elsewhere')
    write(pathlib.join(elsewhere, 'package.json'), '{}')
    process.chdir(elsewhere)
    expect((await idf(['--version'])).args).toEqual([
      '-B',
      pathlib.join(elsewhere, '.mikro', 'build-fw'),
      '--version',
    ])
  })
})
