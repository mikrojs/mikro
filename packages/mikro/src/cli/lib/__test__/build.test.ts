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
import {build, type BuildEvent, buildTests, entryRootDir, OUT_DIR_MARKER} from '../build.js'
import {UserError} from '../errorMessage.js'

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
                {path: 'app/node_modules/c@1.2.0', version: '1.2.0'},
                {path: 'app/node_modules/c@2.0.1', version: '2.0.1'},
              ],
            },
          ],
        },
      ])
      expect(listFiles(buildDir)).to.include('app/node_modules/c@1.2.0/index.js')
      expect(listFiles(buildDir)).to.include('app/node_modules/c@2.0.1/index.js')
      // Importable by name (from the REPL) only where one package has the name.
      expect(
        readFileSync(pathlib.join(buildDir, 'app/node_modules/a/package.json'), 'utf-8'),
      ).to.equal('{"exports":{"./index.js":"./index.js"}}')
      expect(listFiles(buildDir)).to.not.include('app/node_modules/c@1.2.0/package.json')
      expect(listFiles(buildDir)).to.not.include('app/node_modules/c@2.0.1/package.json')
      expect(readFileSync(pathlib.join(buildDir, 'app/node_modules/a/index.js'), 'utf-8')).to.equal(
        "import '../c@1.2.0/index.js'\n",
      )
      expect(readFileSync(pathlib.join(buildDir, 'app/main.js'), 'utf-8')).to.equal(
        "import './node_modules/a/index.js'\nimport './node_modules/b/index.js'\n",
      )
    })

    it('compiles the rewritten imports to bytecode', async () => {
      addPackage('node_modules/a', 'a', '1.0.0', "import 'c/index.js'\n")
      addPackage('node_modules/a/node_modules/c', 'c', '1.2.0', 'export const c = 1\n')
      addPackage('node_modules/c', 'c', '2.0.1', 'export const c = 2\n')
      writeFileSync(
        pathlib.join(tempDir, 'app', 'main.ts'),
        "import 'a/index.js'\nimport 'c/index.js'\n",
      )
      const buildDir = pathlib.join(tempDir, 'out')

      await lastValueFrom(build('app/main.ts', buildDir, {minify: true, bytecode: true}))

      expect(listFiles(buildDir)).to.include.members([
        'app/main.bjs',
        'app/node_modules/a/index.bjs',
        // The app imports c@2.0.1 itself, so that copy keeps the plain name.
        'app/node_modules/c/index.bjs',
        'app/node_modules/c@1.2.0/index.bjs',
      ])
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

  it('deploys a package.json that code imports as it is on disk', async () => {
    const dir = pathlib.join(tempDir, 'node_modules', 'lib')
    const pjson = JSON.stringify({
      name: 'lib',
      version: '1.2.3',
      type: 'module',
      description: 'kept',
      exports: './index.js',
    })
    mkdirSync(dir, {recursive: true})
    writeFileSync(pathlib.join(dir, 'package.json'), pjson)
    writeFileSync(
      pathlib.join(dir, 'index.js'),
      "import meta from './package.json' with {type: 'json'}\nexport default meta\n",
    )
    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), "import 'lib'\n")
    const buildDir = pathlib.join(tempDir, 'out')
    await runBuild('app/main.ts', buildDir)

    const deployed = pathlib.join(buildDir, 'app/node_modules/lib')
    expect(readFileSync(pathlib.join(deployed, '_package.json'), 'utf-8')).to.equal(pjson)
    expect(readFileSync(pathlib.join(deployed, 'package.json'), 'utf-8')).to.equal(
      '{"exports":{".":"./index.js"}}',
    )
  })

  it('refuses to delete a non-empty output directory it did not mark', async () => {
    const markedBuild = build('app/main.ts', tempDir, {
      minify: false,
      bytecode: false,
      markOutDir: true,
    })
    await expect(lastValueFrom(markedBuild)).rejects.toBeInstanceOf(UserError)
    expect(readFileSync(pathlib.join(tempDir, 'app', 'main.ts'), 'utf-8')).to.equal(
      'export const a = 1\n',
    )
  })

  it('marks the output directory, rebuilds into it, and leaves the marker unlisted', async () => {
    const buildDir = pathlib.join(tempDir, 'out')
    const markedBuild = () =>
      lastValueFrom(
        build('app/main.ts', buildDir, {minify: false, bytecode: false, markOutDir: true}).pipe(
          toArray(),
        ),
      )
    await markedBuild()
    const events = await markedBuild()

    expect(listFiles(buildDir)).to.include(OUT_DIR_MARKER)
    const listed = events.flatMap((e) => (e.type === 'file' ? [e.path] : []))
    expect(listed).to.deep.equal(['/app/main.js', '/app/mikro.config.json', '/app/package.json'])
  })

  it('reports trace problems as a UserError, so the CLI prints them without a stack', async () => {
    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), "import 'lalala'\n")
    await expect(runBuild('app/main.ts', pathlib.join(tempDir, 'out'))).rejects.toBeInstanceOf(
      UserError,
    )
  })

  // The build rewrites imports in .ts, .js and .mjs only. A .tsx file would
  // deploy with its imports as written, and fail on the device.
  it('refuses a file whose imports it cannot rewrite', async () => {
    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), "import './view.tsx'\n")
    writeFileSync(pathlib.join(tempDir, 'app', 'view.tsx'), "import './dep.ts'\n")
    writeFileSync(pathlib.join(tempDir, 'app', 'dep.ts'), 'export {}\n')
    await expect(runBuild('app/main.ts', pathlib.join(tempDir, 'out'))).rejects.toThrow(
      'Cannot deploy "app/view.tsx": its imports have to be rewritten, and the build rewrites ' +
        'only .ts, .js, .mjs files',
    )
  })

  // `board` and `features` steer flash/build on the host; leaking them
  // would land them in device RAM via mikro.config.json on every boot.
  it('strips board and features from the deployed runtime config', async () => {
    writeFileSync(
      pathlib.join(tempDir, 'mikro.config.ts'),
      `export default {board: 'esp32c6-generic', features: ['ble'], wifi: {country: 'NO'}}\n`,
    )
    const buildDir = pathlib.join(tempDir, 'out-host-only')
    await runBuild('app/main.ts', buildDir)

    const runtime = JSON.parse(
      readFileSync(pathlib.join(buildDir, 'app', 'mikro.config.json'), 'utf-8'),
    )
    expect(runtime.board).toBeUndefined()
    expect(runtime.features).toBeUndefined()
    expect(runtime['wifi.country']).toBe('NO')
  })

  async function runBuildEvents(entry: string, buildDir: string): Promise<BuildEvent[]> {
    return lastValueFrom(build(entry, buildDir, {minify: false, bytecode: false}).pipe(toArray()))
  }

  function featuresEvent(events: BuildEvent[]) {
    return events.find((e) => e.type === 'features')
  }

  it('derives required features from static imports and optional from dynamic-only', async () => {
    writeFileSync(
      pathlib.join(tempDir, 'app', 'main.ts'),
      `import {wifi} from 'mikro/wifi'\n` +
        `export async function go() {\n` +
        `  const ble = await import('mikro/ble')\n` +
        `  return [wifi, ble]\n` +
        `}\n`,
    )
    const events = await runBuildEvents('app/main.ts', pathlib.join(tempDir, 'out-feat'))
    expect(featuresEvent(events)).toEqual({
      type: 'features',
      imported: ['wifi'],
      floor: [],
      optional: ['ble'],
      modules: {wifi: ['wifi']},
    })
  })

  it('ignores type-only imports: no feature required, no unknown-module error', async () => {
    writeFileSync(
      pathlib.join(tempDir, 'app', 'main.ts'),
      `import type {BleError} from 'mikro/ble'\n` +
        `import type {FormatOptions} from 'mikro/format'\n` +
        `export type {WifiError} from 'mikro/wifi'\n` +
        `export const e: BleError | FormatOptions | undefined = undefined\n`,
    )
    const events = await runBuildEvents('app/main.ts', pathlib.join(tempDir, 'out-type-only'))
    expect(featuresEvent(events)).toEqual({
      type: 'features',
      imported: [],
      floor: [],
      optional: [],
      modules: {},
    })
  })

  it('reports the config feature floor minus already-imported features', async () => {
    writeFileSync(
      pathlib.join(tempDir, 'mikro.config.ts'),
      `export default {features: ['ble', 'wifi']}\n`,
    )
    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), `import 'mikro/wifi'\n`)
    const events = await runBuildEvents('app/main.ts', pathlib.join(tempDir, 'out-floor'))
    expect(featuresEvent(events)).toEqual({
      type: 'features',
      imported: ['wifi'],
      floor: ['ble'],
      optional: [],
      modules: {wifi: ['wifi']},
    })
  })

  it('buildTests emits the same features derivation as build', async () => {
    writeFileSync(
      pathlib.join(tempDir, 'app', 'debug', 'test.ts'),
      `import 'mikro/wifi'\n` +
        `export async function go() {\n` +
        `  return import('mikro/ble')\n` +
        `}\n`,
    )
    const events = await lastValueFrom(
      buildTests(['app/debug/test.ts'], pathlib.join(tempDir, 'out-tests'), {
        minify: false,
        bytecode: false,
        rootDir: 'app',
      }).pipe(toArray()),
    )
    expect(featuresEvent(events)).toEqual({
      type: 'features',
      imported: ['wifi'],
      floor: [],
      optional: ['ble'],
      modules: {wifi: ['wifi']},
    })
  })

  it('errors on unknown mikro/* imports with a suggestion', async () => {
    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), `import 'mikro/wify'\n`)
    const failure = runBuild('app/main.ts', pathlib.join(tempDir, 'out-unknown'))
    await expect(failure).rejects.toThrow("Unknown module 'mikro/wify'. Did you mean 'mikro/wifi'?")
    // A typo is the user's to fix, so it must not print as a crash.
    await expect(failure).rejects.toBeInstanceOf(UserError)
  })

  it('names a value import of a types-only subpath as such', async () => {
    // verbatimModuleSyntax keeps an inline `type` specifier as a side-effect
    // import, so this reaches the device loader unless the build refuses it.
    writeFileSync(
      pathlib.join(tempDir, 'app', 'main.ts'),
      `import {type FormatOptions} from 'mikro/format'\n` +
        `export const o: FormatOptions | undefined = undefined\n`,
    )
    await expect(runBuild('app/main.ts', pathlib.join(tempDir, 'out-types-only'))).rejects.toThrow(
      "'mikro/format' exports types only. Import it with `import type`.",
    )
  })

  it('validates and derives features in bundle mode too', async () => {
    writeFileSync(
      pathlib.join(tempDir, 'app', 'main.ts'),
      `import {wifi} from 'mikro/wifi'\nexport const w = wifi\n`,
    )
    const events = await lastValueFrom(
      build('app/main.ts', pathlib.join(tempDir, 'out-bundle'), {
        minify: false,
        bytecode: false,
        bundle: true,
      }).pipe(toArray()),
    )
    expect(featuresEvent(events)).toEqual({
      type: 'features',
      imported: ['wifi'],
      floor: [],
      optional: [],
      modules: {wifi: ['wifi']},
    })

    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), `import 'mikro/wify'\n`)
    await expect(
      lastValueFrom(
        build('app/main.ts', pathlib.join(tempDir, 'out-bundle-unknown'), {
          minify: false,
          bytecode: false,
          bundle: true,
        }),
      ),
    ).rejects.toThrow("Unknown module 'mikro/wify'")
  })
})
