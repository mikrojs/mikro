import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, relative} from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'

import {nodeFileTrace} from '../src/index.js'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, {recursive: true, force: true})
  root = undefined
})

function write(path: string, contents: string) {
  mkdirSync(dirname(path), {recursive: true})
  writeFileSync(path, contents)
}

function link(target: string, path: string) {
  mkdirSync(dirname(path), {recursive: true})
  symlinkSync(target, path)
}

type Package = {files: Record<string, string>; deps?: Record<string, string>; pjson?: object}

/** A pnpm install: every package sits in the store at `<name>@<version>`, with
 *  its dependencies linked next to it. The app's node_modules links into the
 *  store, which is inside the app (a standalone project) or above it (a
 *  workspace). */
function install(
  storeIn: 'app' | 'workspace',
  packages: Record<string, Package>,
  appDeps: Record<string, string>,
  input: string,
): string {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mik-pnpm-')))
  const app = join(root, 'app')
  const store = join(storeIn === 'app' ? app : root, 'node_modules/.pnpm')
  const pkg = (name: string, pjson: object = {}) =>
    JSON.stringify({name, type: 'module', exports: {'./*': './*'}, ...pjson})
  // pnpm names a scoped package's store directory `@scope+name@version`.
  const inStore = (name: string, version: string) =>
    join(store, `${name.replace('/', '+')}@${version}`, 'node_modules')
  for (const [id, {files, deps = {}, pjson = {}}] of Object.entries(packages)) {
    const name = id.slice(0, id.lastIndexOf('@'))
    const dir = inStore(name, id.slice(name.length + 1))
    write(join(dir, name, 'package.json'), pkg(name, pjson))
    for (const [file, contents] of Object.entries(files)) write(join(dir, name, file), contents)
    for (const [dep, version] of Object.entries(deps)) {
      link(relative(dirname(join(dir, dep)), join(inStore(dep, version), dep)), join(dir, dep))
    }
  }
  for (const [dep, version] of Object.entries(appDeps)) {
    link(join(inStore(dep, version), dep), join(app, 'node_modules', dep))
  }
  write(join(app, 'package.json'), pkg('app'))
  write(join(app, 'input.js'), input)
  return app
}

async function trace(app: string, expectWarnings = false) {
  const {fileList, sourcePathMap, warnings} = await nodeFileTrace([join(app, 'input.js')], {
    processCwd: app,
    base: app,
  })
  if (!expectWarnings) expect([...warnings]).toEqual([])
  return {
    files: [...fileList].sort(),
    warnings: [...warnings].map((warning) => warning.message),
    // Returns the store package that a deployed file is read from.
    source: (file: string) =>
      realpathSync(sourcePathMap.get(file) ?? join(app, file))
        .split('/.pnpm/')[1]
        ?.split('/')[0],
  }
}

describe.each(['app', 'workspace'] as const)('a pnpm store in the %s', (storeIn) => {
  it('deploys packages at the node_modules paths the device looks in', async () => {
    const app = install(
      storeIn,
      {
        'a@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'b@1.0.0': {files: {'index.js': "import './lib.js'\n", 'lib.js': 'export const b = 1\n'}},
      },
      {a: '1.0.0'},
      "import 'a/index.js'\n",
    )
    const {files} = await trace(app)

    expect(files).toEqual([
      'input.js',
      'node_modules/a/index.js',
      'node_modules/a/node_modules/b/index.js',
      'node_modules/a/node_modules/b/lib.js',
      'node_modules/a/node_modules/b/package.json',
      'node_modules/a/package.json',
      'package.json',
    ])
  })

  it('gives every copy of a shared dependency its package.json and its own dependencies', async () => {
    const app = install(
      storeIn,
      {
        'a@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'c@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'b@1.0.0': {files: {'index.js': "import 'x/index.js'\n"}, deps: {x: '1.0.0'}},
        'x@1.0.0': {files: {'index.js': 'export const x = 1\n'}},
      },
      {a: '1.0.0', c: '1.0.0'},
      "import 'a/index.js'\nimport 'c/index.js'\n",
    )
    const {files} = await trace(app)

    expect(files).toEqual([
      'input.js',
      'node_modules/a/index.js',
      'node_modules/a/node_modules/b/index.js',
      'node_modules/a/node_modules/b/node_modules/x/index.js',
      'node_modules/a/node_modules/b/node_modules/x/package.json',
      'node_modules/a/node_modules/b/package.json',
      'node_modules/a/package.json',
      'node_modules/c/index.js',
      'node_modules/c/node_modules/b/index.js',
      'node_modules/c/node_modules/b/node_modules/x/index.js',
      'node_modules/c/node_modules/b/node_modules/x/package.json',
      'node_modules/c/node_modules/b/package.json',
      'node_modules/c/package.json',
      'package.json',
    ])
  })

  it("resolves a dependency's import to its own version, not the app's", async () => {
    const app = install(
      storeIn,
      {
        'a@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '2.0.0'}},
        'b@1.0.0': {files: {'index.js': 'export const v = 1\n'}},
        'b@2.0.0': {files: {'index.js': 'export const v = 2\n'}},
      },
      {a: '1.0.0', b: '1.0.0'},
      "import 'a/index.js'\nimport 'b/index.js'\n",
    )
    const {files, source} = await trace(app)

    expect(files).toEqual([
      'input.js',
      'node_modules/a/index.js',
      'node_modules/a/node_modules/b/index.js',
      'node_modules/a/node_modules/b/package.json',
      'node_modules/a/package.json',
      'node_modules/b/index.js',
      'node_modules/b/package.json',
      'package.json',
    ])
    expect(source('node_modules/a/node_modules/b/index.js')).toBe('b@2.0.0')
  })

  it('shares the copy the app already has when the version matches', async () => {
    const app = install(
      storeIn,
      {
        'a@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'b@1.0.0': {files: {'index.js': 'export const b = 1\n'}},
      },
      {a: '1.0.0', b: '1.0.0'},
      "import 'a/index.js'\nimport 'b/index.js'\n",
    )
    const {files} = await trace(app)

    expect(files).toEqual([
      'input.js',
      'node_modules/a/index.js',
      'node_modules/a/package.json',
      'node_modules/b/index.js',
      'node_modules/b/package.json',
      'package.json',
    ])
  })

  it('finishes when packages import each other', async () => {
    const app = install(
      storeIn,
      {
        'a@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'b@1.0.0': {files: {'index.js': "import 'x/index.js'\n"}, deps: {x: '1.0.0'}},
        'x@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
      },
      {a: '1.0.0'},
      "import 'a/index.js'\n",
    )
    const {files} = await trace(app)

    expect(files).toEqual([
      'input.js',
      'node_modules/a/index.js',
      'node_modules/a/node_modules/b/index.js',
      'node_modules/a/node_modules/b/node_modules/x/index.js',
      'node_modules/a/node_modules/b/node_modules/x/package.json',
      'node_modules/a/node_modules/b/package.json',
      'node_modules/a/package.json',
      'package.json',
    ])
  })

  it("keeps a dependency's version when its importer nests another one later", async () => {
    // `a` reaches b@2 through a chain of files, so `c` asks for b@1 first. The
    // app's b@1 must not be shared: `a`'s b@2 is placed between `c` and that copy.
    const hops = 8
    const chain: Record<string, string> = {'index.js': "import 'c/index.js'\nimport './hop0.js'\n"}
    for (let i = 0; i < hops; i++) chain[`hop${i}.js`] = `import './hop${i + 1}.js'\n`
    chain[`hop${hops}.js`] = "import 'b/index.js'\n"
    const app = install(
      storeIn,
      {
        'a@1.0.0': {files: chain, deps: {b: '2.0.0', c: '1.0.0'}},
        'c@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'b@1.0.0': {files: {'index.js': 'export const v = 1\n'}},
        'b@2.0.0': {files: {'index.js': 'export const v = 2\n'}},
      },
      {a: '1.0.0', b: '1.0.0'},
      "import 'a/index.js'\nimport 'b/index.js'\n",
    )
    const {files, source} = await trace(app)

    expect(files.filter((file) => file.endsWith('b/index.js'))).toEqual([
      'node_modules/a/node_modules/b/index.js',
      'node_modules/a/node_modules/c/node_modules/b/index.js',
      'node_modules/b/index.js',
    ])
    expect(source('node_modules/a/node_modules/b/index.js')).toBe('b@2.0.0')
    expect(source('node_modules/a/node_modules/c/node_modules/b/index.js')).toBe('b@1.0.0')
  })

  it('warns when a version nested later hides a copy it shared', async () => {
    // As above, but `a` does not depend on b: it finds the b@2 that pnpm hoists
    // into the store. The tracer cannot know that `a` nests a `b` until it reaches
    // that import.
    const hops = 8
    const chain: Record<string, string> = {'index.js': "import 'c/index.js'\nimport './hop0.js'\n"}
    for (let i = 0; i < hops; i++) chain[`hop${i}.js`] = `import './hop${i + 1}.js'\n`
    chain[`hop${hops}.js`] = "import 'b/index.js'\n"
    const app = install(
      storeIn,
      {
        'a@1.0.0': {files: chain, deps: {c: '1.0.0'}},
        'c@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
        'b@1.0.0': {files: {'index.js': 'export const v = 1\n'}},
        'b@2.0.0': {files: {'index.js': 'export const v = 2\n'}},
      },
      {a: '1.0.0', b: '1.0.0'},
      "import 'a/index.js'\n",
    )
    const store = join(app, storeIn === 'app' ? '' : '..', 'node_modules/.pnpm')
    link('../b@2.0.0/node_modules/b', join(store, 'node_modules/b'))
    const {warnings} = await trace(app, true)

    expect(warnings).toEqual([
      'On the device, "b" imported from "node_modules/a/node_modules/c" resolves to ' +
        '"node_modules/a/node_modules/b", which is not the version the build resolved',
    ])
  })

  it('nests a second copy of a package under another version of itself', async () => {
    // q needs b@1 again, below p's b@2. The second b@1 shares the p above it,
    // so the nesting ends.
    const app = install(
      storeIn,
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
    const {files, source} = await trace(app)

    const q = 'node_modules/b/node_modules/p/node_modules/q'
    expect(files.filter((file) => file.startsWith(q))).toEqual([
      `${q}/index.js`,
      `${q}/node_modules/b/index.js`,
      `${q}/node_modules/b/package.json`,
      `${q}/package.json`,
    ])
    expect(source(`${q}/node_modules/b/index.js`)).toBe('b@1.0.0')
  })

  it('warns and finishes when two versions of two packages import each other', async () => {
    const app = install(
      storeIn,
      {
        'b@1.0.0': {files: {'index.js': "import 'x/index.js'\n"}, deps: {x: '1.0.0'}},
        'x@1.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '2.0.0'}},
        'b@2.0.0': {files: {'index.js': "import 'x/index.js'\n"}, deps: {x: '2.0.0'}},
        'x@2.0.0': {files: {'index.js': "import 'b/index.js'\n"}, deps: {b: '1.0.0'}},
      },
      {b: '1.0.0'},
      "import 'b/index.js'\n",
    )
    const {warnings} = await trace(app, true)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"b"')
  })

  it('places scoped packages, `.` exports and `#` imports', async () => {
    const app = install(
      storeIn,
      {
        '@acme/a@1.0.0': {
          files: {'index.js': "import '#util'\nimport '@acme/b'\n", 'util.js': 'export {}\n'},
          deps: {'@acme/b': '1.0.0'},
          pjson: {exports: {'.': './index.js'}, imports: {'#util': './util.js'}},
        },
        '@acme/b@1.0.0': {
          files: {'dist/index.js': 'export {}\n'},
          pjson: {exports: {'.': './dist/index.js'}},
        },
      },
      {'@acme/a': '1.0.0'},
      "import '@acme/a'\n",
    )
    const {files} = await trace(app)

    expect(files).toEqual([
      'input.js',
      'node_modules/@acme/a/index.js',
      'node_modules/@acme/a/node_modules/@acme/b/dist/index.js',
      'node_modules/@acme/a/node_modules/@acme/b/package.json',
      'node_modules/@acme/a/package.json',
      'node_modules/@acme/a/util.js',
      'package.json',
    ])
  })
})
