import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, isAbsolute, join} from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'

import {applyRewrites, type FileSystem, traceImports} from '../src/index.js'
import {type Package, pkg, pnpmInstall} from './install.js'
import {memoryFs} from './memoryFs.js'

async function trace(
  fs: FileSystem,
  root: string,
  entry = 'input.js',
  isExternal?: (specifier: string) => boolean,
) {
  const result = await traceImports([`${root}/${entry}`], {
    root,
    fs,
    assetExtensions: ['.txt'],
    ...(isExternal ? {isExternal} : {}),
  })
  return {
    ...result,
    paths: [...result.files.keys()].sort(),
    // The file as it deploys: its source with the import specifiers replaced.
    code: async (path: string) => {
      const file = result.files.get(path)!
      if ('contents' in file) return file.contents
      return applyRewrites((await fs.readFile(file.source))!, file.rewrites)
    },
  }
}

describe.each(['app', 'workspace'] as const)('a pnpm store in the %s', (storeIn) => {
  const install = (packages: Record<string, Package>, deps: Record<string, string>, input: string) =>
    pnpmInstall(storeIn, packages, deps, input)

  it('deploys each package in one directory and imports it by relative path', async () => {
    const {app, fs} = install(
      {
        'a@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'b@1.0.0': {files: {'index.js': "import './lib.js'\n", 'lib.js': 'export const b = 1\n'}},
      },
      {a: '1.0.0'},
      "import 'a/index.js'\n",
    )
    const {paths, problems, code} = await trace(fs(), app)

    expect(problems).toEqual([])
    expect(paths).toEqual([
      'input.js',
      'node_modules/a/index.js',
      'node_modules/a/package.json',
      'node_modules/b/index.js',
      'node_modules/b/lib.js',
      'node_modules/b/package.json',
    ])
    expect(await code('input.js')).toBe("import './node_modules/a/index.js'\n")
    expect(await code('node_modules/a/index.js')).toBe("import '../b/index.js'\n")
    expect(await code('node_modules/b/index.js')).toBe("import './lib.js'\n")
  })

  it('deploys a dependency that two packages share once, with its own dependencies', async () => {
    const {app, fs} = install(
      {
        'a@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'c@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'b@1.0.0': {files: {'index.js': "import 'x/index.js'\n"}, deps: {x: '1.0.0'}},
        'x@1.0.0': {files: {'index.js': 'export const x = 1\n'}},
      },
      {a: '1.0.0', c: '1.0.0'},
      "import 'a/index.js'\nimport 'c/index.js'\n",
    )
    const {paths, problems, duplicatePackages} = await trace(fs(), app)

    expect(problems).toEqual([])
    expect(duplicatePackages).toEqual([])
    expect(paths).toEqual([
      'input.js',
      'node_modules/a/index.js',
      'node_modules/a/package.json',
      'node_modules/b/index.js',
      'node_modules/b/package.json',
      'node_modules/c/index.js',
      'node_modules/c/package.json',
      'node_modules/x/index.js',
      'node_modules/x/package.json',
    ])
  })

  it("points a dependency's import at its own version, not the app's", async () => {
    const {app, fs} = install(
      {
        'a@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '2.0.0'}},
        'b@1.0.0': {files: {'index.js': 'export const v = 1\n'}},
        'b@2.0.0': {files: {'index.js': 'export const v = 2\n'}},
      },
      {a: '1.0.0', b: '1.0.0'},
      "import 'a/index.js'\nimport 'b/index.js'\n",
    )
    const {paths, problems, duplicatePackages, code} = await trace(fs(), app)

    expect(problems).toEqual([])
    expect(paths).toEqual([
      'input.js',
      'node_modules/a/index.js',
      'node_modules/a/package.json',
      // The copy the app imports keeps the name, so the REPL can import it too.
      'node_modules/b/index.js',
      'node_modules/b/package.json',
      'node_modules/b@2.0.0/index.js',
    ])
    expect(await code('input.js')).toBe(
      "import './node_modules/a/index.js'\nimport './node_modules/b/index.js'\n",
    )
    expect(await code('node_modules/a/index.js')).toBe("import '../b@2.0.0/index.js'\n")
    expect(await code('node_modules/b@2.0.0/index.js')).toBe('export const v = 2\n')
    expect(duplicatePackages).toEqual([
      {
        name: 'b',
        copies: [
          {path: 'node_modules/b', version: '1.0.0'},
          {path: 'node_modules/b@2.0.0', version: '2.0.0'},
        ],
      },
    ])
  })

  it('finishes when packages import each other', async () => {
    const {app, fs} = install(
      {
        'a@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'b@1.0.0': {files: {'index.js': "import 'x/index.js'\n"}, deps: {x: '1.0.0'}},
        'x@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
      },
      {a: '1.0.0'},
      "import 'a/index.js'\n",
    )
    const {paths, problems} = await trace(fs(), app)

    expect(problems).toEqual([])
    expect(paths).toEqual([
      'input.js',
      'node_modules/a/index.js',
      'node_modules/a/package.json',
      'node_modules/b/index.js',
      'node_modules/b/package.json',
      'node_modules/x/index.js',
      'node_modules/x/package.json',
    ])
  })

  it('deploys two versions of two packages that import each other', async () => {
    const {app, fs} = install(
      {
        'b@1.0.0': {files: {'index.js': "import 'x/index.js'\n"}, deps: {x: '1.0.0'}},
        'x@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '2.0.0'}},
        'b@2.0.0': {files: {'index.js': "import 'x/index.js'\n"}, deps: {x: '2.0.0'}},
        'x@2.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
      },
      {b: '1.0.0'},
      "import 'b/index.js'\n",
    )
    const {paths, problems, code} = await trace(fs(), app)

    expect(problems).toEqual([])
    expect(paths).toEqual([
      'input.js',
      // The app imports b@1, so that copy keeps the name. It imports neither x.
      'node_modules/b/index.js',
      'node_modules/b/package.json',
      'node_modules/b@2.0.0/index.js',
      'node_modules/x@1.0.0/index.js',
      'node_modules/x@2.0.0/index.js',
    ])
    expect(await code('node_modules/x@1.0.0/index.js')).toBe("import '../b@2.0.0/index.js'\n")
    expect(await code('node_modules/x@2.0.0/index.js')).toBe("import '../b/index.js'\n")
  })

  it('follows a package that pnpm hoisted into the store, not the version the app has', async () => {
    // `a` does not depend on b: it finds the b@2 that pnpm hoists into the store.
    const {app, store, links, fs} = install(
      {
        'a@1.0.0': {
          files: {'index.js': "import 'c/index.js'\nimport 'b/index.js'\n"},
          deps: {c: '1.0.0'},
        },
        'c@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'b@1.0.0': {files: {'index.js': 'export const v = 1\n'}},
        'b@2.0.0': {files: {'index.js': 'export const v = 2\n'}},
      },
      {a: '1.0.0', b: '1.0.0'},
      "import 'a/index.js'\n",
    )
    links[`${store}/node_modules/b`] = '../b@2.0.0/node_modules/b'
    const {problems, code} = await trace(fs(), app)

    expect(problems).toEqual([])
    expect(await code('node_modules/a/index.js')).toBe(
      "import '../c/index.js'\nimport '../b@2.0.0/index.js'\n",
    )
    expect(await code('node_modules/c/index.js')).toBe("import '../b@1.0.0/index.js'\n")
  })

  it('resolves scoped packages, `.` exports, wildcards and `#` imports on the host', async () => {
    const {app, fs} = install(
      {
        '@acme/a@1.0.0': {
          files: {
            'index.js': "import '#util'\nimport '@acme/b'\nimport '@acme/b/fonts/mono'\n",
            'util.js': 'export {}\n',
          },
          deps: {'@acme/b': '1.0.0'},
          pjson: {exports: {'.': './index.js'}, imports: {'#util': './util.js'}},
        },
        '@acme/b@1.0.0': {
          files: {'dist/index.js': 'export {}\n', 'dist/fonts/mono.js': 'export {}\n'},
          pjson: {
            exports: {'.': {import: './dist/index.js'}, './fonts/*': './dist/fonts/*.js'},
          },
        },
      },
      {'@acme/a': '1.0.0'},
      "import '@acme/a'\n",
    )
    const {paths, problems, code} = await trace(fs(), app)

    expect(problems).toEqual([])
    expect(paths).toEqual([
      'input.js',
      'node_modules/@acme/a/index.js',
      'node_modules/@acme/a/package.json',
      'node_modules/@acme/a/util.js',
      'node_modules/@acme/b/dist/fonts/mono.js',
      'node_modules/@acme/b/dist/index.js',
      'node_modules/@acme/b/package.json',
    ])
    // What the device's resolver cannot read (conditions, wildcards) is flattened
    // to the subpaths the app imports.
    expect(JSON.parse(await code('node_modules/@acme/b/package.json'))).toEqual({
      exports: {'.': './dist/index.js', './fonts/mono': './dist/fonts/mono.js'},
    })
    expect(await code('input.js')).toBe("import './node_modules/@acme/a/index.js'\n")
    expect(await code('node_modules/@acme/a/index.js')).toBe(
      "import './util.js'\nimport '../b/dist/index.js'\nimport '../b/dist/fonts/mono.js'\n",
    )
  })
})

describe('packages with one name', () => {
  it('keeps each version apart when one imports a package that imports the other', async () => {
    // q needs b@1 again, below p's b@2.
    const {app, fs} = pnpmInstall(
      'app',
      {
        'b@1.0.0': {files: {'index.js': "import 'p/index.js'\n"}, deps: {p: '1.0.0'}},
        'p@1.0.0': {
          files: {'index.js': "import 'b/index.js'\nimport 'q/index.js'\n"},
          deps: {b: '2.0.0', q: '1.0.0'},
        },
        'q@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'b@2.0.0': {files: {'index.js': 'export const v = 2\n'}},
      },
      {b: '1.0.0'},
      "import 'b/index.js'\n",
    )
    const {problems, code} = await trace(fs(), app)

    expect(problems).toEqual([])
    expect(await code('node_modules/p/index.js')).toBe(
      "import '../b@2.0.0/index.js'\nimport '../q/index.js'\n",
    )
    expect(await code('node_modules/q/index.js')).toBe("import '../b/index.js'\n")
  })

  it('numbers two copies on disk that have the same version', async () => {
    // npm nests a copy under each importer when it cannot hoist one.
    const copy = JSON.stringify({name: 'c', version: '1.0.0', type: 'module', exports: './index.js'})
    const fs = memoryFs({
      '/ws/app/package.json': pkg('app'),
      '/ws/app/input.js': "import 'a/index.js'\nimport 'b/index.js'\n",
      '/ws/app/node_modules/a/package.json': pkg('a'),
      '/ws/app/node_modules/a/index.js': "import 'c'\n",
      '/ws/app/node_modules/a/node_modules/c/package.json': copy,
      '/ws/app/node_modules/a/node_modules/c/index.js': 'export {}\n',
      '/ws/app/node_modules/b/package.json': pkg('b'),
      '/ws/app/node_modules/b/index.js': "import 'c'\n",
      '/ws/app/node_modules/b/node_modules/c/package.json': copy,
      '/ws/app/node_modules/b/node_modules/c/index.js': 'export {}\n',
    })
    const {problems, duplicatePackages, code} = await trace(fs, '/ws/app')

    expect(problems).toEqual([])
    expect(duplicatePackages).toEqual([
      {
        name: 'c',
        copies: [
          {path: 'node_modules/c@1.0.0', version: '1.0.0'},
          {path: 'node_modules/c@1.0.0_2', version: '1.0.0'},
        ],
      },
    ])
    expect(await code('node_modules/a/index.js')).toBe("import '../c@1.0.0/index.js'\n")
    expect(await code('node_modules/b/index.js')).toBe("import '../c@1.0.0_2/index.js'\n")
  })

  it('gives no copy the plain name when app files import two of them', async () => {
    const copy = (version: string) =>
      JSON.stringify({name: 'c', version, type: 'module', exports: './index.js'})
    const fs = memoryFs({
      '/ws/app/package.json': pkg('app'),
      '/ws/app/input.js': "import 'c'\nimport './sub/x.js'\n",
      '/ws/app/sub/x.js': "import 'c'\n",
      '/ws/app/node_modules/c/package.json': copy('1.0.0'),
      '/ws/app/node_modules/c/index.js': 'export {}\n',
      '/ws/app/sub/node_modules/c/package.json': copy('2.0.0'),
      '/ws/app/sub/node_modules/c/index.js': 'export {}\n',
    })
    const {paths, problems} = await trace(fs, '/ws/app')

    expect(problems).toEqual([])
    expect(paths).toEqual([
      'input.js',
      'node_modules/c@1.0.0/index.js',
      'node_modules/c@2.0.0/index.js',
      'sub/x.js',
    ])
  })

  it('deploys a package under its own name when the app imports it by an alias', async () => {
    const fs = memoryFs(
      {
        '/ws/app/package.json': pkg('app'),
        '/ws/app/input.js': "import 'alias/index.js'\n",
        '/ws/pkgs/real/package.json': pkg('real'),
        '/ws/pkgs/real/index.js': 'export {}\n',
      },
      {'/ws/app/node_modules/alias': '../../pkgs/real'},
    )
    const {paths, problems, code} = await trace(fs, '/ws/app')

    expect(problems).toEqual([])
    // No package.json: nothing imports it as `real`, so there is no subpath to map.
    expect(paths).toEqual(['input.js', 'node_modules/real/index.js'])
    expect(await code('input.js')).toBe("import './node_modules/real/index.js'\n")
  })
})

describe('a linked workspace package', () => {
  it('deploys once when the app and another package both reach it', async () => {
    const fs = memoryFs(
      {
        '/ws/app/package.json': pkg('app'),
        '/ws/app/input.js': "import 'board/index.js'\nimport 'util/index.js'\n",
        '/ws/pkgs/board/package.json': pkg('board'),
        '/ws/pkgs/board/index.js': "import 'util/index.js'\n",
        '/ws/pkgs/util/package.json': pkg('util'),
        '/ws/pkgs/util/index.js': 'export const util = 1\n',
      },
      {
        '/ws/app/node_modules/board': '../../pkgs/board',
        '/ws/app/node_modules/util': '../../pkgs/util',
        '/ws/pkgs/board/node_modules/util': '../../util',
      },
    )
    const {paths, problems, duplicatePackages} = await trace(fs, '/ws/app')

    expect(problems).toEqual([])
    expect(duplicatePackages).toEqual([])
    expect(paths).toEqual([
      'input.js',
      'node_modules/board/index.js',
      'node_modules/board/package.json',
      'node_modules/util/index.js',
      'node_modules/util/package.json',
    ])
  })

  it('finds a package that only the path it was reached at can see', async () => {
    // `board` imports `util` without depending on it. Node resolves from the real
    // path, pkgs/board, and fails. The trace also tries the path the file was
    // reached at, the app's node_modules/board, as the device used to.
    const fs = memoryFs(
      {
        '/ws/app/package.json': pkg('app'),
        '/ws/app/input.js': "import 'board/index.js'\n",
        '/ws/pkgs/board/package.json': pkg('board'),
        '/ws/pkgs/board/index.js': "import 'util/index.js'\n",
        '/ws/pkgs/util/package.json': pkg('util'),
        '/ws/pkgs/util/index.js': 'export const util = 1\n',
      },
      {
        '/ws/app/node_modules/board': '../../pkgs/board',
        '/ws/app/node_modules/util': '../../pkgs/util',
      },
    )
    const {paths, problems, code} = await trace(fs, '/ws/app')

    expect(problems).toEqual([])
    expect(paths).toEqual([
      'input.js',
      'node_modules/board/index.js',
      'node_modules/board/package.json',
      'node_modules/util/index.js',
      'node_modules/util/package.json',
    ])
    expect(await code('node_modules/board/index.js')).toBe("import '../util/index.js'\n")
  })

  it('finds it from every file of the linked package, not only the one imported', async () => {
    const fs = memoryFs(
      {
        '/ws/app/package.json': pkg('app'),
        '/ws/app/input.js': "import 'board/index.js'\n",
        '/ws/pkgs/board/package.json': pkg('board'),
        '/ws/pkgs/board/index.js': "import './lib/sub.js'\n",
        '/ws/pkgs/board/lib/sub.js': "import 'util/index.js'\n",
        '/ws/pkgs/util/package.json': pkg('util'),
        '/ws/pkgs/util/index.js': 'export const util = 1\n',
      },
      {
        '/ws/app/node_modules/board': '../../pkgs/board',
        '/ws/app/node_modules/util': '../../pkgs/util',
      },
    )
    const {problems, code} = await trace(fs, '/ws/app')

    expect(problems).toEqual([])
    expect(await code('node_modules/board/lib/sub.js')).toBe("import '../../util/index.js'\n")
  })

  it('gives two packages with one name and no version a directory each', async () => {
    const nameOnly = JSON.stringify({name: 'b', type: 'module', exports: {'./*': './*'}})
    const fs = memoryFs(
      {
        '/ws/app/package.json': pkg('app'),
        '/ws/app/input.js': "import 'a/index.js'\nimport 'b/index.js'\n",
        '/ws/app/node_modules/a/package.json': pkg('a'),
        '/ws/app/node_modules/a/index.js': "import 'b/index.js'\n",
        '/ws/app/node_modules/a/node_modules/b/package.json': nameOnly,
        '/ws/app/node_modules/a/node_modules/b/index.js': 'export const v = 2\n',
        '/ws/app/node_modules/b/package.json': nameOnly,
        '/ws/app/node_modules/b/index.js': 'export const v = 1\n',
      },
      {},
    )
    const {problems, duplicatePackages, code} = await trace(fs, '/ws/app')

    expect(problems).toEqual([])
    expect(duplicatePackages).toEqual([
      {name: 'b', copies: [{path: 'node_modules/b_2'}, {path: 'node_modules/b'}]},
    ])
    expect(await code('node_modules/a/index.js')).toBe("import '../b_2/index.js'\n")
    expect(await code('input.js')).toBe(
      "import './node_modules/a/index.js'\nimport './node_modules/b/index.js'\n",
    )
  })
})

describe('an app', () => {
  const app = (files: Record<string, string>) =>
    memoryFs(
      Object.fromEntries([
        ['/ws/app/package.json', pkg('app')],
        ...Object.entries(files).map(([path, source]) => [`/ws/app/${path}`, source]),
      ]),
    )

  it('deploys TypeScript as JavaScript and leaves a specifier that already fits', async () => {
    const fs = app({
      'src/main.ts': "import './lib/wifi.ts'\nimport './lib/led.js'\nimport './config.json'\n",
      'src/lib/wifi.ts': 'export {}\n',
      'src/lib/led.ts': 'export {}\n',
      'src/config.json': '{}',
    })
    const {paths, problems, files, code} = await trace(fs, '/ws/app', 'src/main.ts')

    expect(problems).toEqual([])
    expect(paths).toEqual(['src/config.json', 'src/lib/led.js', 'src/lib/wifi.js', 'src/main.js'])
    expect(files.get('src/main.js')).toEqual({
      source: '/ws/app/src/main.ts',
      rewrites: [{start: 8, end: 21, text: './lib/wifi.js'}],
    })
    expect(await code('src/main.js')).toBe(
      "import './lib/wifi.js'\nimport './lib/led.js'\nimport './config.json'\n",
    )
  })

  it('reports builtins with their kind and does not resolve them', async () => {
    const fs = app({
      'input.js':
        "import 'mikro/wifi'\nimport './dep.js'\nawait import('mikro/ble')\nawait import('mikro/wifi')\n",
      'dep.js': "await import('mikro/ble')\nimport 'mikro/gpio'\n",
    })
    const {problems, externals, code} = await trace(fs, '/ws/app', 'input.js', (specifier) =>
      specifier.startsWith('mikro/'),
    )

    expect(problems).toEqual([])
    expect([...externals].sort()).toEqual([
      ['mikro/ble', 'dynamic'],
      ['mikro/gpio', 'static'],
      ['mikro/wifi', 'static'],
    ])
    expect(await code('input.js')).toContain("import 'mikro/wifi'")
  })

  it('rewrites the literals of an import() and accepts a computed relative one', async () => {
    const fs = pnpmInstall(
      'app',
      {'a@1.0.0': {files: {'en.js': 'export {}\n', 'no.js': 'export {}\n'}}},
      {a: '1.0.0'},
      "await import(flag ? 'a/en.js' : 'a/no.js')\nawait import('./lang/' + 'en.js')\n",
    )
    fs.files['/ws/app/lang/en.js'] = 'export {}\n'
    const {problems, code} = await trace(fs.fs(), fs.app)

    expect(problems).toEqual([])
    expect(await code('input.js')).toBe(
      "await import(flag ? './node_modules/a/en.js' : './node_modules/a/no.js')\n" +
        "await import('./lang/' + 'en.js')\n",
    )
  })

  it('refuses a computed import() that it would have to rewrite', async () => {
    const fs = pnpmInstall(
      'app',
      {'a@1.0.0': {files: {'en.js': 'export {}\n'}}},
      {a: '1.0.0'},
      "await import('a/' + 'en.js')\n",
    )
    const {problems} = await trace(fs.fs(), fs.app)

    expect(problems).toEqual([
      'Cannot deploy import("a/en.js") in "input.js": the specifier is computed, so the build ' +
        'cannot point it at "node_modules/a/en.js". Use a string literal.',
    ])
  })

  it('reports an import of a file outside the app directory', async () => {
    const fs = memoryFs({
      '/ws/app/package.json': pkg('app'),
      '/ws/app/input.js': "import '../shared/x.js'\n",
      '/ws/shared/x.js': 'export const x = 1\n',
    })
    const {paths, problems} = await trace(fs, '/ws/app')

    expect(paths).toEqual(['input.js'])
    expect(problems).toEqual([
      'Cannot deploy "../shared/x.js", imported from "input.js": it is outside the app directory',
    ])
  })

  it('reports a relative import that leaves its package', async () => {
    const fs = memoryFs({
      '/ws/app/package.json': pkg('app'),
      '/ws/app/input.js': "import 'a/index.js'\n",
      '/ws/app/node_modules/a/package.json': pkg('a'),
      '/ws/app/node_modules/a/index.js': "import '../b/index.js'\n",
      '/ws/app/node_modules/b/package.json': pkg('b'),
      '/ws/app/node_modules/b/index.js': 'export {}\n',
    })
    const {problems} = await trace(fs, '/ws/app')

    expect(problems).toEqual([
      'Cannot deploy "node_modules/b/index.js", imported from "node_modules/a/index.js": ' +
        'it is outside its package',
    ])
  })

  it('reports an entry that does not exist', async () => {
    const fs = memoryFs({'/ws/app/package.json': pkg('app')})
    const {paths, problems} = await trace(fs, '/ws/app')

    expect(paths).toEqual([])
    expect(problems).toEqual(['Cannot find entry "/ws/app/input.js"'])
  })

  it('reports an import that does not resolve, a file that does not parse, and CommonJS', async () => {
    const fs = memoryFs({
      '/ws/app/package.json': pkg('app'),
      '/ws/app/input.js': "import './missing.js'\nimport './broken.js'\nimport 'cjs/index.js'\n",
      '/ws/app/broken.js': 'import {',
      '/ws/app/node_modules/cjs/package.json': JSON.stringify({name: 'cjs', exports: {'./*': './*'}}),
      '/ws/app/node_modules/cjs/index.js': 'module.exports = 1\n',
    })
    const {problems} = await trace(fs, '/ws/app')

    // The specifier as written, not the `.ts` one the trace also tried.
    expect(problems[0]).toBe(
      'Failed to resolve dependency "./missing.js":\n' +
        "Cannot find module '/ws/app/missing.js' loaded from /ws/app/input.js",
    )
    expect(problems.map((problem) => problem.split('\n')[0])).toEqual([
      'Failed to resolve dependency "./missing.js":',
      'Failed to parse /ws/app/broken.js as module:',
      'Non-ESM dependency detected: cjs',
    ])
  })
})

describe('a deploy directory below the app directory', () => {
  it('holds the files outside it, and the specifiers follow', async () => {
    const {app, files, fs} = pnpmInstall(
      'app',
      {'a@1.0.0': {files: {'index.js': 'export {}\n'}}},
      {a: '1.0.0'},
      '',
    )
    files[`${app}/src/main.js`] = "import 'a/index.js'\nimport '../test/helper.js'\n"
    files[`${app}/test/helper.js`] = 'export {}\n'
    const result = await traceImports([`${app}/src/main.js`], {
      root: app,
      deployDir: 'src',
      fs: fs(),
    })

    expect(result.problems).toEqual([])
    expect([...result.files.keys()].sort()).toEqual([
      'src/main.js',
      'src/node_modules/a/index.js',
      'src/node_modules/a/package.json',
      'src/test/helper.js',
    ])
    const main = result.files.get('src/main.js')!
    expect('rewrites' in main && main.rewrites.map(({text}) => text)).toEqual([
      './node_modules/a/index.js',
      './test/helper.js',
    ])
  })
})

describe('a deployed package', () => {
  it('gets a package.json for the REPL that maps what the app imports, not its own', async () => {
    const {app, fs} = pnpmInstall(
      'app',
      {
        'a@1.0.0': {
          files: {'index.js': "import meta from './package.json' with {type: 'json'}\n"},
        },
      },
      {a: '1.0.0'},
      "import 'a/index.js'\n",
    )
    const {paths, problems, code} = await trace(fs(), app)

    expect(problems).toEqual([])
    expect(paths).toEqual([
      'input.js',
      'node_modules/a/_package.json',
      'node_modules/a/index.js',
      'node_modules/a/package.json',
    ])
    expect(await code('node_modules/a/package.json')).toBe(
      '{"exports":{"./index.js":"./index.js"}}',
    )
    expect(await code('node_modules/a/index.js')).toBe(
      "import meta from './_package.json' with {type: 'json'}\n",
    )
  })
})

describe('the disk', () => {
  let root: string | undefined
  afterEach(() => {
    if (root !== undefined) rmSync(root, {recursive: true, force: true})
    root = undefined
  })

  it('traces a pnpm install the same way the in-memory tree does', async () => {
    const {app, files, links, fs} = pnpmInstall(
      'workspace',
      {
        'a@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '2.0.0'}},
        'b@1.0.0': {files: {'index.js': 'export const v = 1\n'}},
        'b@2.0.0': {files: {'index.js': 'export const v = 2\n'}},
      },
      {a: '1.0.0', b: '1.0.0'},
      "import 'a/index.js'\nimport 'b/index.js'\n",
    )
    const dir = (root = realpathSync(mkdtempSync(join(tmpdir(), 'mik-trace-'))))
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(dir + path), {recursive: true})
      writeFileSync(dir + path, contents)
    }
    for (const [path, target] of Object.entries(links)) {
      mkdirSync(dirname(dir + path), {recursive: true})
      symlinkSync(isAbsolute(target) ? dir + target : target, dir + path)
    }

    const summary = ({files, ...rest}: Awaited<ReturnType<typeof traceImports>>, prefix: string) => ({
      ...rest,
      files: [...files].map(([path, file]) => [
        path,
        'source' in file ? {...file, source: file.source.slice(prefix.length)} : file,
      ]),
    })
    const inMemory = await traceImports([`${app}/input.js`], {root: app, fs: fs()})
    const onDisk = await traceImports([`${dir}${app}/input.js`], {root: dir + app})

    expect(inMemory.problems).toEqual([])
    expect(summary(onDisk, dir)).toEqual(summary(inMemory, ''))
  })
})

describe('applyRewrites', () => {
  it('applies rewrites given in any order', () => {
    expect(
      applyRewrites("import 'a'; import 'bb'", [
        {start: 8, end: 9, text: './x/a.js'},
        {start: 20, end: 22, text: './y.js'},
      ]),
    ).toBe("import './x/a.js'; import './y.js'")
  })
})
