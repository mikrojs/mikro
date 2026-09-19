import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterEach, expect, it} from 'vitest'

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

const pkg = (name: string) => JSON.stringify({name, type: 'module', exports: {'./*': './*'}})

it('warns about an import of a file outside the app directory', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mik-outside-')))
  const app = join(root, 'app')
  write(join(app, 'package.json'), pkg('app'))
  write(join(app, 'input.js'), "import '../shared/x.js'\n")
  write(join(root, 'shared/x.js'), 'export const x = 1\n')

  const {fileList, warnings} = await nodeFileTrace([join(app, 'input.js')], {
    processCwd: app,
    base: app,
  })

  expect([...fileList].sort()).toEqual(['input.js', 'package.json'])
  expect([...warnings].map((warning) => warning.message)).toEqual([
    'Cannot deploy "../shared/x.js", imported from "input.js": it is outside the app directory',
  ])
})

it('finds a package that only the deployed path can see', async () => {
  // A linked package imports `util` without depending on it. Node can't find it
  // from pkgs/board, but the device finds the app's copy from node_modules/board.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mik-outside-')))
  const app = join(root, 'app')
  write(join(app, 'package.json'), pkg('app'))
  write(join(app, 'input.js'), "import 'board/index.js'\n")
  write(join(root, 'pkgs/board/package.json'), pkg('board'))
  write(join(root, 'pkgs/board/index.js'), "import 'util/index.js'\n")
  write(join(root, 'pkgs/util/package.json'), pkg('util'))
  write(join(root, 'pkgs/util/index.js'), 'export const util = 1\n')
  mkdirSync(join(app, 'node_modules'))
  symlinkSync('../../pkgs/board', join(app, 'node_modules/board'))
  symlinkSync('../../pkgs/util', join(app, 'node_modules/util'))

  const {fileList, warnings} = await nodeFileTrace([join(app, 'input.js')], {
    processCwd: app,
    base: app,
  })

  expect([...warnings]).toEqual([])
  expect([...fileList].sort()).toEqual([
    'input.js',
    'node_modules/board/index.js',
    'node_modules/board/package.json',
    'node_modules/util/index.js',
    'node_modules/util/package.json',
    'package.json',
  ])
})
