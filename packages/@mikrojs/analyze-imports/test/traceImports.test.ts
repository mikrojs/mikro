import {describe, expect, it} from 'vitest'

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
      'node_modules/b/index.js',
      'node_modules/b/lib.js',
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
      'node_modules/b/index.js',
      'node_modules/c/index.js',
      'node_modules/x/index.js',
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
      'node_modules/b@1.0.0/index.js',
      'node_modules/b@2.0.0/index.js',
    ])
    expect(await code('input.js')).toBe(
      "import './node_modules/a/index.js'\nimport './node_modules/b@1.0.0/index.js'\n",
    )
    expect(await code('node_modules/a/index.js')).toBe("import '../b@2.0.0/index.js'\n")
    expect(await code('node_modules/b@2.0.0/index.js')).toBe('export const v = 2\n')
    expect(duplicatePackages).toEqual([
      {
        name: 'b',
        copies: [
          {path: 'node_modules/b@1.0.0', version: '1.0.0'},
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
      'node_modules/b/index.js',
      'node_modules/x/index.js',
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
      'node_modules/b@1.0.0/index.js',
      'node_modules/b@2.0.0/index.js',
      'node_modules/x@1.0.0/index.js',
      'node_modules/x@2.0.0/index.js',
    ])
    expect(await code('node_modules/x@1.0.0/index.js')).toBe("import '../b@2.0.0/index.js'\n")
    expect(await code('node_modules/x@2.0.0/index.js')).toBe("import '../b@1.0.0/index.js'\n")
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
      'node_modules/@acme/a/util.js',
      'node_modules/@acme/b/dist/fonts/mono.js',
      'node_modules/@acme/b/dist/index.js',
    ])
    expect(await code('input.js')).toBe("import './node_modules/@acme/a/index.js'\n")
    expect(await code('node_modules/@acme/a/index.js')).toBe(
      "import './util.js'\nimport '../b/dist/index.js'\nimport '../b/dist/fonts/mono.js'\n",
    )
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
    expect(paths).toEqual(['input.js', 'node_modules/board/index.js', 'node_modules/util/index.js'])
  })

  it('finds a package that only the path it was reached at can see', async () => {
    // `board` imports `util` without depending on it. Node can't find it from
    // pkgs/board, but does from the app's node_modules/board.
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
    expect(paths).toEqual(['input.js', 'node_modules/board/index.js', 'node_modules/util/index.js'])
    expect(await code('node_modules/board/index.js')).toBe("import '../util/index.js'\n")
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
      {name: 'b', copies: [{path: 'node_modules/b'}, {path: 'node_modules/b_2'}]},
    ])
    expect(await code('node_modules/a/index.js')).toBe("import '../b/index.js'\n")
    expect(await code('input.js')).toBe(
      "import './node_modules/a/index.js'\nimport './node_modules/b_2/index.js'\n",
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

  it('reports an import that does not resolve, a file that does not parse, and CommonJS', async () => {
    const fs = memoryFs({
      '/ws/app/package.json': pkg('app'),
      '/ws/app/input.js': "import './missing.js'\nimport './broken.js'\nimport 'cjs/index.js'\n",
      '/ws/app/broken.js': 'import {',
      '/ws/app/node_modules/cjs/package.json': JSON.stringify({name: 'cjs', exports: {'./*': './*'}}),
      '/ws/app/node_modules/cjs/index.js': 'module.exports = 1\n',
    })
    const {problems} = await trace(fs, '/ws/app')

    expect(problems.map((problem) => problem.split('\n')[0])).toEqual([
      'Failed to resolve dependency "./missing.js":',
      'Failed to parse /ws/app/broken.js as module:',
      'Non-ESM dependency detected: cjs',
    ])
  })
})

describe('a deployed package', () => {
  it('cannot be imported by name: no package.json deploys into its directory', async () => {
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
    expect(paths).toEqual(['input.js', 'node_modules/a/_package.json', 'node_modules/a/index.js'])
    expect(await code('node_modules/a/index.js')).toBe(
      "import meta from './_package.json' with {type: 'json'}\n",
    )
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
