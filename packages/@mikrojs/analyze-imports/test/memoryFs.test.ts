import {expect, it} from 'vitest'

import {nodeFileTrace} from '../src/index.js'
import {memoryFs} from './memoryFs.js'

const pkg = (name: string) => JSON.stringify({name, type: 'module', exports: {'./*': './*'}})

it('traces a tree that is not on disk, through symlinks', async () => {
  const fs = memoryFs(
    {
      '/ws/app/package.json': pkg('app'),
      '/ws/app/input.js': "import 'board/index.js'\n",
      '/ws/pkgs/board/package.json': pkg('board'),
      '/ws/pkgs/board/index.js': "import './pins.js'\n",
      '/ws/pkgs/board/pins.js': 'export {}\n',
    },
    {'/ws/app/node_modules/board': '../../pkgs/board'},
  )

  const {fileList, warnings, sourcePathMap} = await nodeFileTrace(['/ws/app/input.js'], {
    base: '/ws/app',
    fs,
  })

  expect([...warnings]).toEqual([])
  expect([...fileList].sort()).toEqual([
    'input.js',
    'node_modules/board/index.js',
    'node_modules/board/package.json',
    'node_modules/board/pins.js',
    'package.json',
  ])
  expect(sourcePathMap.get('node_modules/board/pins.js')).toBe('/ws/pkgs/board/pins.js')
})
