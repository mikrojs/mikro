import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'

import {nodeFileTrace} from '../src/index.js'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, {recursive: true, force: true})
  root = undefined
})

const pkg = (name: string, version?: string) =>
  JSON.stringify({name, version, type: 'module', exports: {'./*': './*'}})

/** A workspace in a temp dir: `files` by path, `links` from a node_modules path
 *  to the package directory it points at. Returns the app directory. */
function workspace(files: Record<string, string>, links: Record<string, string>): string {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mik-duplicates-')))
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), {recursive: true})
    writeFileSync(join(root, path), contents)
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), {recursive: true})
    symlinkSync(join(root, target), join(root, path))
  }
  return join(root, 'app')
}

/** `a` and `b` both import `c`; `c-v1` and `c-v2` are two versions of it. */
const FILES = {
  'app/package.json': pkg('app'),
  'pkgs/a/package.json': pkg('a', '1.0.0'),
  'pkgs/a/index.js': "import 'c/index.js'\n",
  'pkgs/b/package.json': pkg('b', '1.0.0'),
  'pkgs/b/index.js': "import 'c/index.js'\n",
  'pkgs/c-v1/package.json': pkg('c', '1.2.0'),
  'pkgs/c-v1/index.js': 'export const c = 1\n',
  'pkgs/c-v2/package.json': pkg('c', '2.0.1'),
  'pkgs/c-v2/index.js': 'export const c = 2\n',
}

async function duplicatesOf(app: string) {
  const {duplicatePackages} = await nodeFileTrace([join(app, 'input.js')], {
    processCwd: app,
    base: app,
  })
  return duplicatePackages
}

describe('duplicatePackages', () => {
  it('reports two versions at two nested paths', async () => {
    const app = workspace(
      {...FILES, 'app/input.js': "import 'a/index.js'\nimport 'b/index.js'\n"},
      {
        'app/node_modules/a': 'pkgs/a',
        'app/node_modules/b': 'pkgs/b',
        'pkgs/a/node_modules/c': 'pkgs/c-v1',
        'pkgs/b/node_modules/c': 'pkgs/c-v2',
      },
    )

    expect(await duplicatesOf(app)).toEqual([
      {
        name: 'c',
        copies: [
          {path: 'node_modules/a/node_modules/c', version: '1.2.0'},
          {path: 'node_modules/b/node_modules/c', version: '2.0.1'},
        ],
      },
    ])
  })

  it('reports an outer version and a nested one', async () => {
    const app = workspace(
      {...FILES, 'app/input.js': "import 'a/index.js'\nimport 'c/index.js'\n"},
      {
        'app/node_modules/a': 'pkgs/a',
        'app/node_modules/c': 'pkgs/c-v1',
        'pkgs/a/node_modules/c': 'pkgs/c-v2',
      },
    )

    expect(await duplicatesOf(app)).toEqual([
      {
        name: 'c',
        copies: [
          {path: 'node_modules/a/node_modules/c', version: '2.0.1'},
          {path: 'node_modules/c', version: '1.2.0'},
        ],
      },
    ])
  })

  it('reports the same package at two nested paths with no outer copy', async () => {
    const app = workspace(
      {...FILES, 'app/input.js': "import 'a/index.js'\nimport 'b/index.js'\n"},
      {
        'app/node_modules/a': 'pkgs/a',
        'app/node_modules/b': 'pkgs/b',
        'pkgs/a/node_modules/c': 'pkgs/c-v1',
        'pkgs/b/node_modules/c': 'pkgs/c-v1',
      },
    )

    expect(await duplicatesOf(app)).toEqual([
      {
        name: 'c',
        copies: [
          {path: 'node_modules/a/node_modules/c', version: '1.2.0'},
          {path: 'node_modules/b/node_modules/c', version: '1.2.0'},
        ],
      },
    ])
  })

  it('reports a nested copy the hoist left in place', async () => {
    // `c` has no `util` of its own: inside `a` it finds the copy in `a`, which
    // the outer path cannot reach, so the nested `c` stays.
    const app = workspace(
      {
        ...FILES,
        'app/input.js': "import 'a/index.js'\nimport 'c/index.js'\n",
        'pkgs/a/index.js': "import 'c/util.js'\n",
        'pkgs/c-v1/util.js': "import 'util/index.js'\n",
        'pkgs/util/package.json': pkg('util', '1.0.0'),
        'pkgs/util/index.js': 'export const util = 1\n',
      },
      {
        'app/node_modules/a': 'pkgs/a',
        'app/node_modules/c': 'pkgs/c-v1',
        'pkgs/a/node_modules/c': 'pkgs/c-v1',
        'pkgs/a/node_modules/util': 'pkgs/util',
      },
    )

    expect(await duplicatesOf(app)).toEqual([
      {
        name: 'c',
        copies: [
          {path: 'node_modules/a/node_modules/c', version: '1.2.0'},
          {path: 'node_modules/c', version: '1.2.0'},
        ],
      },
    ])
  })

  it('reports nothing when the hoist leaves one copy', async () => {
    const app = workspace(
      {...FILES, 'app/input.js': "import 'a/index.js'\nimport 'c/index.js'\n"},
      {
        'app/node_modules/a': 'pkgs/a',
        'app/node_modules/c': 'pkgs/c-v1',
        'pkgs/a/node_modules/c': 'pkgs/c-v1',
      },
    )

    expect(await duplicatesOf(app)).toEqual([])
  })

  it('leaves the version out when package.json has none', async () => {
    const app = workspace(
      {
        ...FILES,
        'app/input.js': "import 'a/index.js'\nimport 'b/index.js'\n",
        'pkgs/c-v2/package.json': pkg('c'),
      },
      {
        'app/node_modules/a': 'pkgs/a',
        'app/node_modules/b': 'pkgs/b',
        'pkgs/a/node_modules/c': 'pkgs/c-v1',
        'pkgs/b/node_modules/c': 'pkgs/c-v2',
      },
    )

    expect(await duplicatesOf(app)).toEqual([
      {
        name: 'c',
        copies: [
          {path: 'node_modules/a/node_modules/c', version: '1.2.0'},
          {path: 'node_modules/b/node_modules/c'},
        ],
      },
    ])
  })
})
