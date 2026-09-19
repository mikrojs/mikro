import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {lastValueFrom, toArray} from 'rxjs'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import type {LogLevel, MikroEnv} from '../../../_exports/index.js'
import {build, type BuildEvent, entryRootDir} from '../build.js'

function listFiles(dir: string): string[] {
  return (readdirSync(dir, {recursive: true}) as string[])
    .filter((p) => statSync(pathlib.join(dir, p)).isFile())
    .sort()
}

async function runBuild(entry: string, buildDir: string) {
  await lastValueFrom(build(entry, buildDir, {minify: false, bytecode: false}))
}

describe('entryRootDir', () => {
  it('returns the top-level directory of a nested entry', () => {
    expect(entryRootDir('app/main.ts')).to.equal('app')
    expect(entryRootDir('app/debug/test.ts')).to.equal('app')
  })

  it('returns "." for an entry at the project root', () => {
    expect(entryRootDir('main.ts')).to.equal('.')
  })
})

describe('build', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    // realpath so absolute-entry paths compare cleanly against process.cwd()
    // (macOS tmpdir is a symlink; cwd always reports the real path)
    tempDir = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'build-')))
    writeFileSync(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', version: '0.0.0', type: 'module'}),
    )
    writeFileSync(pathlib.join(tempDir, 'mikro.config.ts'), 'export default {}\n')
    mkdirSync(pathlib.join(tempDir, 'app', 'debug'), {recursive: true})
    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), 'export const a = 1\n')
    writeFileSync(pathlib.join(tempDir, 'app', 'debug', 'test.ts'), 'export const b = 2\n')
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tempDir, {recursive: true, force: true})
  })

  it('places package.json and mikro.config.json in the entry top-level dir', async () => {
    const buildDir = pathlib.join(tempDir, 'out')
    await runBuild('app/main.ts', buildDir)

    expect(listFiles(buildDir)).to.deep.equal([
      'app/main.js',
      'app/mikro.config.json',
      'app/package.json',
    ])
    const pkg = JSON.parse(readFileSync(pathlib.join(buildDir, 'app', 'package.json'), 'utf-8'))
    expect(pkg.main).to.equal('./main.js')
  })

  it('keeps package.json and mikro.config.json at the top-level dir for nested entries', async () => {
    const buildDir = pathlib.join(tempDir, 'out')
    await runBuild('app/debug/test.ts', buildDir)

    expect(listFiles(buildDir)).to.deep.equal([
      'app/debug/test.js',
      'app/mikro.config.json',
      'app/package.json',
    ])
    const pkg = JSON.parse(readFileSync(pathlib.join(buildDir, 'app', 'package.json'), 'utf-8'))
    expect(pkg.main).to.equal('./debug/test.js')
  })

  it('builds the same tree for absolute entry paths', async () => {
    const buildDir = pathlib.join(tempDir, 'out-abs')
    await runBuild(pathlib.join(tempDir, 'app', 'debug', 'test.ts'), buildDir)

    expect(listFiles(buildDir)).to.deep.equal([
      'app/debug/test.js',
      'app/mikro.config.json',
      'app/package.json',
    ])
  })

  // The schema ships in the manifest (app/mikro.app.json); leaking the ota
  // group here would put a copy of it in device RAM on every boot.
  it('strips the host-only ota group from the deployed runtime config', async () => {
    writeFileSync(
      pathlib.join(tempDir, 'mikro.config.ts'),
      `export default {wifi: {country: 'NO'}, otaConfigSchema: {kind: 'object', shape: {}}}\n`,
    )
    const buildDir = pathlib.join(tempDir, 'out-ota')
    await runBuild('app/main.ts', buildDir)

    const runtime = JSON.parse(
      readFileSync(pathlib.join(buildDir, 'app', 'mikro.config.json'), 'utf-8'),
    )
    expect(runtime.ota).toBeUndefined()
    expect(runtime['wifi.country']).toBe('NO')
  })

  it('builds the same tree for ./-prefixed and bare entry paths', async () => {
    const bareDir = pathlib.join(tempDir, 'out-bare')
    const dotDir = pathlib.join(tempDir, 'out-dot')
    await runBuild('app/debug/test.ts', bareDir)
    await runBuild('./app/debug/test.ts', dotDir)

    expect(listFiles(dotDir)).to.deep.equal(listFiles(bareDir))
  })

  describe('duplicate packages', () => {
    const pkg = (name: string, version: string) =>
      JSON.stringify({name, version, type: 'module', exports: {'./*': './*'}})

    function addPackage(dir: string, name: string, version: string, source: string) {
      mkdirSync(pathlib.join(tempDir, dir), {recursive: true})
      writeFileSync(pathlib.join(tempDir, dir, 'package.json'), pkg(name, version))
      writeFileSync(pathlib.join(tempDir, dir, 'index.js'), source)
    }

    async function duplicateEvents(buildDir: string, options?: {bundle: boolean}) {
      const events = await lastValueFrom(
        build('app/main.ts', buildDir, {minify: false, bytecode: false, ...options}).pipe(
          toArray(),
        ),
      )
      return events.filter(
        (e): e is Extract<BuildEvent, {type: 'duplicatePackages'}> =>
          e.type === 'duplicatePackages',
      )
    }

    it('reports two copies of a package by deploy path, and still builds', async () => {
      addPackage('node_modules/a', 'a', '1.0.0', "import 'c/index.js'\n")
      addPackage('node_modules/b', 'b', '1.0.0', "import 'c/index.js'\n")
      addPackage('node_modules/a/node_modules/c', 'c', '1.2.0', 'export const c = 1\n')
      addPackage('node_modules/b/node_modules/c', 'c', '2.0.1', 'export const c = 2\n')
      writeFileSync(
        pathlib.join(tempDir, 'app', 'main.ts'),
        "import 'a/index.js'\nimport 'b/index.js'\n",
      )
      const buildDir = pathlib.join(tempDir, 'out')

      expect(await duplicateEvents(buildDir)).to.deep.equal([
        {
          type: 'duplicatePackages',
          packages: [
            {
              name: 'c',
              copies: [
                {path: 'app/node_modules/a/node_modules/c', version: '1.2.0'},
                {path: 'app/node_modules/b/node_modules/c', version: '2.0.1'},
              ],
            },
          ],
        },
      ])
      expect(listFiles(buildDir)).to.include('app/node_modules/a/node_modules/c/index.js')
      expect(listFiles(buildDir)).to.include('app/node_modules/b/node_modules/c/index.js')
    })

    // Bundled builds go through esbuild, not the tracer: no duplicate report.
    it('reports nothing for a bundled build', async () => {
      addPackage('node_modules/a', 'a', '1.0.0', "import 'c/index.js'\n")
      addPackage('node_modules/b', 'b', '1.0.0', "import 'c/index.js'\n")
      addPackage('node_modules/a/node_modules/c', 'c', '1.2.0', 'export const c = 1\n')
      addPackage('node_modules/b/node_modules/c', 'c', '2.0.1', 'export const c = 2\n')
      writeFileSync(
        pathlib.join(tempDir, 'app', 'main.ts'),
        "import 'a/index.js'\nimport 'b/index.js'\n",
      )

      expect(await duplicateEvents(pathlib.join(tempDir, 'out'), {bundle: true})).to.deep.equal([])
    })

    it('reports nothing when every package deploys once', async () => {
      addPackage('node_modules/a', 'a', '1.0.0', 'export const a = 1\n')
      writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), "import 'a/index.js'\n")

      expect(await duplicateEvents(pathlib.join(tempDir, 'out'))).to.deep.equal([])
    })
  })

  describe('log level', () => {
    // A production build unless `env` says otherwise: the level it resolved, and
    // whether the minified entry kept the call.
    async function buildConsoleLog(options: {logLevel?: LogLevel; env?: MikroEnv} = {}) {
      writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), "console.log('hi')\n")
      const buildDir = pathlib.join(tempDir, 'out')
      const events = await lastValueFrom(
        build('app/main.ts', buildDir, {
          minify: true,
          bytecode: false,
          env: 'production',
          ...options,
        }).pipe(toArray()),
      )
      const settings = events.find(
        (e): e is Extract<BuildEvent, {type: 'settings'}> => e.type === 'settings',
      )
      const code = readFileSync(pathlib.join(buildDir, 'app', 'main.js'), 'utf-8')
      return {logLevel: settings?.logLevel, keepsLog: code.includes('console.log')}
    }

    function configureLogLevel(logLevel: LogLevel) {
      writeFileSync(
        pathlib.join(tempDir, 'mikro.config.ts'),
        `export default {build: {logLevel: '${logLevel}'}}\n`,
      )
    }

    it('drops console.log from a production build by default', async () => {
      expect(await buildConsoleLog()).to.deep.equal({logLevel: 'warn', keepsLog: false})
    })

    it('keeps console.log in a development build by default', async () => {
      expect(await buildConsoleLog({env: 'development'})).to.deep.equal({
        logLevel: 'debug',
        keepsLog: true,
      })
    })

    it('uses build.logLevel from mikro.config.ts over the production default', async () => {
      configureLogLevel('debug')
      expect(await buildConsoleLog()).to.deep.equal({logLevel: 'debug', keepsLog: true})
    })

    it('uses --loglevel over mikro.config.ts', async () => {
      configureLogLevel('debug')
      expect(await buildConsoleLog({logLevel: 'warn'})).to.deep.equal({
        logLevel: 'warn',
        keepsLog: false,
      })
    })
  })

  it('reports an unresolvable import by its message, without an Error prefix', async () => {
    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), "import 'lalala'\n")
    const buildDir = pathlib.join(tempDir, 'out')
    await expect(runBuild('app/main.ts', buildDir)).rejects.toThrow(
      /^Failed to resolve dependency "lalala"/,
    )
  })
})
