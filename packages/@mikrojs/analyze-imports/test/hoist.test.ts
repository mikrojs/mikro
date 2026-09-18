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

function write(path: string, contents: string) {
  mkdirSync(dirname(path), {recursive: true})
  writeFileSync(path, contents)
}

function link(target: string, path: string) {
  mkdirSync(dirname(path), {recursive: true})
  symlinkSync(target, path)
}

/** A workspace: `app` depends on `board` and `driver`, and `board` has its own
 *  node_modules link to a `driver`. Only the board reaches `touch.js`, which
 *  imports the driver's own dependency `util`. */
function workspace(boardsDriver: string, utilOwner: 'driver' | 'board' = 'driver'): string {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mik-hoist-')))
  const pkg = (name: string) => JSON.stringify({name, type: 'module', exports: {'./*': './*'}})
  write(join(root, 'app/package.json'), pkg('app'))
  write(join(root, 'pkgs/board/package.json'), pkg('board'))
  write(join(root, 'pkgs/board/display.js'), "import 'driver/st.js'\nimport 'driver/touch.js'\n")
  for (const dir of ['driver', 'driver-v2']) {
    write(join(root, `pkgs/${dir}/package.json`), pkg('driver'))
    write(join(root, `pkgs/${dir}/st.js`), 'export const st = 1\n')
    write(join(root, `pkgs/${dir}/touch.js`), "import 'util/index.js'\n")
    if (utilOwner === 'driver') link('../../util', join(root, `pkgs/${dir}/node_modules/util`))
  }
  if (utilOwner === 'board') link('../../util', join(root, 'pkgs/board/node_modules/util'))
  write(join(root, 'pkgs/util/package.json'), pkg('util'))
  write(join(root, 'pkgs/util/index.js'), 'export const util = 1\n')
  link('../../pkgs/board', join(root, 'app/node_modules/board'))
  link('../../pkgs/driver', join(root, 'app/node_modules/driver'))
  link(`../../${boardsDriver}`, join(root, 'pkgs/board/node_modules/driver'))
  write(join(root, 'app/input.js'), "import 'board/display.js'\nimport 'driver/st.js'\n")
  return join(root, 'app')
}

describe('a package reached at two node_modules paths', () => {
  it('is traced once, at the outer path, when both are the same package on disk', async () => {
    const app = workspace('driver')
    const {fileList, sourcePathMap} = await nodeFileTrace([join(app, 'input.js')], {
      processCwd: app,
      base: app,
    })

    expect([...fileList].sort()).toEqual([
      'input.js',
      'node_modules/board/display.js',
      'node_modules/board/package.json',
      // The driver's own dependency moves with it, so touch.js still finds it.
      'node_modules/driver/node_modules/util/index.js',
      'node_modules/driver/node_modules/util/package.json',
      'node_modules/driver/package.json',
      'node_modules/driver/st.js',
      // Only the board imports it: it moves out with the rest of the package.
      'node_modules/driver/touch.js',
      'package.json',
    ])
    expect(sourcePathMap.get('node_modules/driver/touch.js')).toBe(
      join(root!, 'pkgs/driver/touch.js'),
    )
  })

  it('keeps the nested copy when it is a different package on disk', async () => {
    const app = workspace('driver-v2')
    const {fileList} = await nodeFileTrace([join(app, 'input.js')], {processCwd: app, base: app})

    expect([...fileList].sort()).toEqual([
      'input.js',
      'node_modules/board/display.js',
      'node_modules/board/node_modules/driver/node_modules/util/index.js',
      'node_modules/board/node_modules/driver/node_modules/util/package.json',
      'node_modules/board/node_modules/driver/package.json',
      'node_modules/board/node_modules/driver/st.js',
      'node_modules/board/node_modules/driver/touch.js',
      'node_modules/board/package.json',
      'node_modules/driver/package.json',
      'node_modules/driver/st.js',
      'package.json',
    ])
  })

  it('keeps the nested copy when it uses a dependency only the nested path can see', async () => {
    // The driver does not have util itself: from inside the board it finds the
    // board's copy, which the outer path cannot reach.
    const app = workspace('driver', 'board')
    const {fileList} = await nodeFileTrace([join(app, 'input.js')], {processCwd: app, base: app})

    expect([...fileList].sort()).toEqual([
      'input.js',
      'node_modules/board/display.js',
      'node_modules/board/node_modules/driver/package.json',
      'node_modules/board/node_modules/driver/st.js',
      'node_modules/board/node_modules/driver/touch.js',
      'node_modules/board/node_modules/util/index.js',
      'node_modules/board/node_modules/util/package.json',
      'node_modules/board/package.json',
      'node_modules/driver/package.json',
      'node_modules/driver/st.js',
      'package.json',
    ])
  })

  it('keeps the guard right after an earlier move (three copies, scoped name)', async () => {
    // app -> a -> b, and all three reach @acme/driver. touch.js, reached only
    // through b, imports util without declaring it and finds a's copy.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mik-hoist-')))
    const pkg = (name: string) => JSON.stringify({name, type: 'module', exports: {'./*': './*'}})
    for (const name of ['app', 'a', 'b', 'util']) {
      write(join(root, `pkgs/${name}/package.json`), pkg(name))
    }
    write(join(root, 'pkgs/driver/package.json'), pkg('@acme/driver'))
    write(join(root, 'pkgs/driver/st.js'), 'export const st = 1\n')
    write(join(root, 'pkgs/driver/touch.js'), "import 'util/index.js'\n")
    write(join(root, 'pkgs/util/index.js'), 'export const util = 1\n')
    write(join(root, 'pkgs/b/index.js'), "import '@acme/driver/touch.js'\n")
    write(join(root, 'pkgs/a/index.js'), "import 'b/index.js'\nimport '@acme/driver/st.js'\n")
    write(join(root, 'pkgs/app/input.js'), "import 'a/index.js'\nimport '@acme/driver/st.js'\n")
    link('../../a', join(root, 'pkgs/app/node_modules/a'))
    link('../../../driver', join(root, 'pkgs/app/node_modules/@acme/driver'))
    link('../../b', join(root, 'pkgs/a/node_modules/b'))
    link('../../util', join(root, 'pkgs/a/node_modules/util'))
    link('../../../driver', join(root, 'pkgs/a/node_modules/@acme/driver'))
    link('../../../driver', join(root, 'pkgs/b/node_modules/@acme/driver'))

    const app = join(root, 'pkgs/app')
    const {fileList} = await nodeFileTrace([join(app, 'input.js')], {processCwd: app, base: app})

    // b's copy moves up into a, where util is still in reach. It stops there:
    // from the app's node_modules, touch.js could not find util.
    expect([...fileList].sort()).toEqual([
      'input.js',
      'node_modules/@acme/driver/package.json',
      'node_modules/@acme/driver/st.js',
      'node_modules/a/index.js',
      'node_modules/a/node_modules/@acme/driver/package.json',
      'node_modules/a/node_modules/@acme/driver/st.js',
      'node_modules/a/node_modules/@acme/driver/touch.js',
      'node_modules/a/node_modules/b/index.js',
      'node_modules/a/node_modules/b/package.json',
      'node_modules/a/node_modules/util/index.js',
      'node_modules/a/node_modules/util/package.json',
      'node_modules/a/package.json',
      'package.json',
    ])
  })
})
