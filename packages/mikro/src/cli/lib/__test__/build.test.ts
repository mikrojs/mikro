import {
  existsSync,
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

  async function runBuildEvents(
    entry: string,
    buildDir: string,
    bundle = false,
  ): Promise<BuildEvent[]> {
    return lastValueFrom(
      build(entry, buildDir, {minify: false, bytecode: false, bundle}).pipe(toArray()),
    )
  }

  function featuresEvent(events: BuildEvent[]) {
    return events.find((e) => e.type === 'features')
  }

  const noNatives = {imported: [], optional: [], owners: {}}

  /** A package `ring` with a native module (`ring/fx`, its export targets
   * C++), a second one (`ring/extra`), and a pure JS driver written in
   * TypeScript (`ring/glue`). */
  function installNativeFixtures() {
    const ring = pathlib.join(tempDir, 'node_modules', 'ring')
    for (const name of ['fx', 'extra']) {
      mkdirSync(pathlib.join(ring, name), {recursive: true})
      writeFileSync(pathlib.join(ring, name, `${name}.cpp`), '// registers the module\n')
      writeFileSync(
        pathlib.join(ring, name, `${name}.d.ts`),
        `export declare const ${name}: number\n`,
      )
      writeFileSync(pathlib.join(ring, name, 'CMakeLists.txt'), 'idf_component_register()\n')
    }
    mkdirSync(pathlib.join(ring, 'glue'), {recursive: true})
    // glue imports its own package's native module by name (self-reference)
    writeFileSync(
      pathlib.join(ring, 'glue', 'glue.ts'),
      "import {fx} from 'ring/fx'\nexport const glue: number = fx\n",
    )
    writeFileSync(
      pathlib.join(ring, 'package.json'),
      JSON.stringify({
        name: 'ring',
        type: 'module',
        exports: {
          './fx': {types: './fx/fx.d.ts', native: './fx/fx.cpp'},
          './extra': {types: './extra/extra.d.ts', native: './extra/extra.cpp'},
          './glue': './glue/glue.ts',
        },
      }),
    )
    // A package whose root export is its native module, with a JavaScript
    // version for host tools that must never reach the device
    const solo = pathlib.join(tempDir, 'node_modules', 'solo')
    mkdirSync(solo, {recursive: true})
    writeFileSync(pathlib.join(solo, 'solo.cpp'), '// registers the module\n')
    writeFileSync(pathlib.join(solo, 'solo.host.js'), 'export const solo = 1\n')
    writeFileSync(pathlib.join(solo, 'CMakeLists.txt'), 'idf_component_register()\n')
    writeFileSync(
      pathlib.join(solo, 'package.json'),
      JSON.stringify({
        name: 'solo',
        type: 'module',
        exports: {'.': {types: './solo.d.ts', native: './solo.cpp', default: './solo.host.js'}},
      }),
    )
  }

  it('points deployed package exports at the .js files TypeScript sources become', async () => {
    installNativeFixtures()
    writeFileSync(
      pathlib.join(tempDir, 'app', 'main.ts'),
      `import {glue} from 'ring/glue'\nexport const out = glue\n`,
    )
    const buildDir = pathlib.join(tempDir, 'out-exports')
    const events = await runBuildEvents('app/main.ts', buildDir, false)
    // The native module glue.ts reaches through its own package name is found
    expect(featuresEvent(events)?.natives.imported).toEqual(['ring/fx'])
    const base = pathlib.join(buildDir, 'app', 'node_modules', 'ring')
    const pkg = JSON.parse(readFileSync(pathlib.join(base, 'package.json'), 'utf-8'))
    expect(pkg.exports['./glue']).toBe('./glue/glue.js')
    expect(existsSync(pathlib.join(base, 'glue', 'glue.js'))).toBe(true)
  })

  for (const bundle of [false, true]) {
    const mode = bundle ? 'bundled' : 'unbundled'

    it(`derives native modules from imports, by package specifier (${mode})`, async () => {
      installNativeFixtures()
      writeFileSync(
        pathlib.join(tempDir, 'app', 'main.ts'),
        `import {fx} from 'ring/fx'\n` +
          `import {glue} from 'ring/glue'\n` +
          `export async function go() {\n` +
          `  const extra = await import('ring/extra')\n` +
          `  return [fx, glue, extra]\n` +
          `}\n`,
      )
      const events = await runBuildEvents(
        'app/main.ts',
        pathlib.join(tempDir, `out-nat-${mode}`),
        bundle,
      )
      expect(featuresEvent(events)).toEqual({
        type: 'features',
        imported: [],
        floor: [],
        optional: [],
        modules: {},
        natives: {
          imported: ['ring/fx'],
          optional: ['ring/extra'],
          owners: {'ring/fx': 'ring/fx', 'ring/extra': 'ring/extra'},
        },
      })
    })

    it(`leaves native modules to the firmware (${mode})`, async () => {
      installNativeFixtures()
      writeFileSync(
        pathlib.join(tempDir, 'app', 'main.ts'),
        `import {fx} from 'ring/fx'\nimport {glue} from 'ring/glue'\nimport {solo} from 'solo'\n` +
          `export const all = [fx, glue, solo]\n`,
      )
      const buildDir = pathlib.join(tempDir, `out-plain-${mode}`)
      await runBuildEvents('app/main.ts', buildDir, bundle)
      const files = listFiles(buildDir)
      // Nothing of a native module is deployed: no C++, no types.
      expect(files.some((f) => f.includes('ring/fx') || f.includes('solo'))).toBe(false)
      const main = readFileSync(pathlib.join(buildDir, 'app', 'main.js'), 'utf-8')
      if (bundle) {
        expect(main).toContain('"ring/fx"')
        expect(main).toContain('"solo"')
        expect(main).not.toContain('"ring/glue"')
      } else {
        expect(main).toContain("'ring/fx'")
        expect(main).toContain("'solo'")
        expect(files).toContain('app/node_modules/ring/glue/glue.js')
      }
    })

    it(`leaves the app's own # native modules to the firmware (${mode})`, async () => {
      writeFileSync(
        pathlib.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'fixture',
          version: '0.0.0',
          type: 'module',
          imports: {'#native/*': {types: './native/*/*.d.ts', native: './native/*/*.cpp'}},
        }),
      )
      const fx = pathlib.join(tempDir, 'native', 'fx')
      mkdirSync(fx, {recursive: true})
      writeFileSync(pathlib.join(fx, 'fx.cpp'), '// registers the module\n')
      writeFileSync(pathlib.join(fx, 'fx.d.ts'), 'export declare const fx: number\n')
      writeFileSync(pathlib.join(fx, 'CMakeLists.txt'), 'idf_component_register()\n')
      writeFileSync(
        pathlib.join(tempDir, 'app', 'main.ts'),
        `import {fx} from '#native/fx'\nexport const out = fx\n`,
      )
      const buildDir = pathlib.join(tempDir, `out-app-native-${mode}`)
      const events = await runBuildEvents('app/main.ts', buildDir, bundle)
      expect(featuresEvent(events)?.natives).toEqual({
        imported: ['#native/fx'],
        optional: [],
        owners: {'#native/fx': 'fixture/native/fx'},
      })
      expect(listFiles(buildDir).some((f) => f.includes('native'))).toBe(false)
      expect(readFileSync(pathlib.join(buildDir, 'app', 'main.js'), 'utf-8')).toContain(
        '#native/fx',
      )
    })

    it(`refuses a # native module of a package other than the app (${mode})`, async () => {
      const dep = pathlib.join(tempDir, 'node_modules', 'dep')
      mkdirSync(pathlib.join(dep, 'fx'), {recursive: true})
      writeFileSync(pathlib.join(dep, 'fx', 'fx.cpp'), '// registers the module\n')
      writeFileSync(pathlib.join(dep, 'fx', 'CMakeLists.txt'), 'idf_component_register()\n')
      writeFileSync(pathlib.join(dep, 'index.js'), "export {fx} from '#fx'\n")
      writeFileSync(
        pathlib.join(dep, 'package.json'),
        JSON.stringify({
          name: 'dep',
          type: 'module',
          exports: './index.js',
          imports: {'#fx': {native: './fx/fx.cpp'}},
        }),
      )
      writeFileSync(
        pathlib.join(tempDir, 'app', 'main.ts'),
        `import {fx} from 'dep'\nexport const out = fx\n`,
      )
      await expect(
        runBuildEvents('app/main.ts', pathlib.join(tempDir, `out-dep-native-${mode}`), bundle),
      ).rejects.toThrow(
        `Cannot import "#fx" in ${pathlib.join(dep, 'package.json')}: only the app can map ` +
          'a # import to a native module',
      )
    })
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
      natives: noNatives,
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
      natives: noNatives,
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
      natives: noNatives,
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
      natives: noNatives,
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
      natives: noNatives,
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
