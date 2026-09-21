import {expect, it} from 'vitest'

import type {Graph} from '../src/discover.js'
import {layout} from '../src/layout.js'

it('lays out a graph without reading anything', () => {
  const graph: Graph = {
    modules: new Map([
      [
        '/ws/app/main.ts',
        {
          path: '/ws/app/main.ts',
          package: '/ws/app',
          imports: [
            {
              specifier: 'font',
              kind: 'static',
              range: [8, 12],
              target: {type: 'file', path: '/store/font@2/index.js'},
            },
            {specifier: 'mikro/wifi', kind: 'dynamic', target: {type: 'external'}},
          ],
        },
      ],
      [
        '/store/font@2/index.js',
        {path: '/store/font@2/index.js', package: '/store/font@2', imports: []},
      ],
    ]),
    packages: new Map([
      ['/ws/app', {dir: '/ws/app', name: 'app'}],
      ['/store/font@2', {dir: '/store/font@2', name: 'font', version: '2.0.0'}],
    ]),
    problems: [],
  }

  expect(layout(graph, '/ws/app')).toEqual({
    files: new Map([
      [
        'main.js',
        {
          source: '/ws/app/main.ts',
          rewrites: [{start: 8, end: 12, text: './node_modules/font/index.js'}],
        },
      ],
      ['node_modules/font/index.js', {source: '/store/font@2/index.js', rewrites: []}],
    ]),
    externals: new Map([['mikro/wifi', 'dynamic']]),
    duplicatePackages: [],
    problems: [],
  })
})

it('reports two sources that deploy to one path', () => {
  const graph: Graph = {
    modules: new Map([
      ['/ws/app/a.ts', {path: '/ws/app/a.ts', imports: []}],
      ['/ws/app/a.js', {path: '/ws/app/a.js', imports: []}],
    ]),
    packages: new Map(),
    problems: [],
  }

  expect(layout(graph, '/ws/app').problems).toEqual([
    'Cannot deploy "/ws/app/a.js" and "/ws/app/a.ts": both deploy to "a.js"',
  ])
})
