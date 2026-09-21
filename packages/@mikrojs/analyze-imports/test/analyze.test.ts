import {expect, it} from 'vitest'

import analyze from '../src/analyze.js'

it('reports every import with its kind and the range of its specifier', async () => {
  const code = [
    '#!/usr/bin/env mikro',
    "import a from 'a'",
    "export * from './b.js'",
    "export {c} from 'c'",
    "import type {T} from './types.js'",
    "const d = await import('d')",
    "const e = await import(flag ? 'e1' : 'e2')",
    "const h = await import(override || 'h')",
    "const f = await import('./f/' + 'g.js')",
    'const unknown = await import(name)',
    "const partlyKnown = await import('./lang/' + code + '.js')",
    'const template = await import(`./lang/${code}.js`)',
  ].join('\n')

  const {imports, parseError} = await analyze('/app/input.ts', code)

  expect(parseError).toBeUndefined()
  expect(imports.map(({specifier, kind}) => [specifier, kind])).toEqual([
    ['a', 'static'],
    ['./b.js', 'static'],
    ['c', 'static'],
    ['d', 'dynamic'],
    ['e1', 'dynamic'],
    ['e2', 'dynamic'],
    ['h', 'dynamic'],
    ['./f/g.js', 'dynamic'],
  ])
  const text = ({range}: (typeof imports)[number]) => range && code.slice(range[0], range[1])
  expect(imports.map(text)).toEqual([
    'a',
    './b.js',
    'c',
    'd',
    'e1',
    'e2',
    'h',
    undefined,
  ])
})

it('returns the parse error', async () => {
  const {imports, parseError} = await analyze('/app/input.js', 'import {')
  expect(imports).toEqual([])
  expect(parseError).toMatch(/^Failed to parse \/app\/input\.js as module:/)
})
