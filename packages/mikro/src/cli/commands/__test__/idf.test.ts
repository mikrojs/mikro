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

/** An app that is its own firmware project, and one with the firmware in a folder. */
const app = pathlib.join(root, 'app')
write(pathlib.join(app, 'package.json'), '{}')
write(pathlib.join(app, 'CMakeLists.txt'), '')
const appWithFolder = pathlib.join(root, 'app-with-folder')
const firmwareFolder = pathlib.join(appWithFolder, 'firmware')
write(pathlib.join(appWithFolder, 'package.json'), '{}')
write(pathlib.join(firmwareFolder, 'CMakeLists.txt'), '')

const originalCwd = process.cwd()

function idf(args: string[], pathDirs: string[] = [idfDir, eimDir]) {
  vi.stubEnv('PATH', [...pathDirs, '/usr/bin', '/bin'].join(':'))
  rmSync(argsFile, {force: true})
  run({action: 'idf', args})
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
  it('runs idf.py directly when it is on PATH, and exits with its code', () => {
    expect(idf(tricky)).toEqual({args: ['-B', appBuildDir, ...tricky], exitCode: 3})
  })

  it('runs idf.py through eim when idf.py is not on PATH', () => {
    expect(idf(tricky, [eimDir])).toEqual({args: ['-B', appBuildDir, ...tricky], exitCode: 3})
  })

  it('says what to do when neither idf.py nor eim is installed', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('PATH', '/usr/bin:/bin')
    run({action: 'idf', args: ['build']})
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('idf.py is not on PATH, and EIM is not installed'),
    )
    expect(process.exitCode).toBe(1)
  })

  it('leaves a build directory given in the arguments alone', () => {
    for (const args of [
      ['-B', 'out', 'build'],
      ['-Bout', 'build'],
      ['--build-dir', 'out', 'build'],
      ['--build-dir=out', 'build'],
    ]) {
      expect(idf(args).args).toEqual(args)
    }
  })

  it('builds in .mikro of the app, named after the folder, when the firmware project is a folder in it', () => {
    process.chdir(firmwareFolder)
    const buildDir = pathlib.join(appWithFolder, '.mikro', 'build-fw-firmware')
    expect(idf(['build']).args).toEqual(['-B', buildDir, 'build'])
  })

  it('finds the project from -C', () => {
    process.chdir(root)
    const buildDir = pathlib.join(appWithFolder, '.mikro', 'build-fw-firmware')
    for (const args of [
      ['-C', 'app-with-folder/firmware', 'build'],
      ['--project-dir=app-with-folder/firmware', 'build'],
    ]) {
      expect(idf(args).args).toEqual(['-B', buildDir, ...args])
    }
  })
})
