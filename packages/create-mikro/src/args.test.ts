import {parseSync} from '@optique/core/parser'
import {describe, expect, it} from 'vitest'

import {args} from './args.js'

function parse(argv: string[]) {
  const result = parseSync(args, argv)
  if (!result.success) throw new Error(`Could not parse ${argv.join(' ')}`)
  return result.value
}

describe('args', () => {
  it('parses no arguments', () => {
    expect(parse([])).toEqual({})
  })

  it('takes the name as the one positional argument', () => {
    expect(parse(['my-app', '-t', 'blinky'])).toEqual({name: 'my-app', template: 'blinky'})
    expect(parse(['.'])).toEqual({name: '.'})
    expect(parse(['board'])).toEqual({name: 'board'})
    expect(parseSync(args, ['app', 'board']).success).toBe(false)
  })

  it('parses a board package', () => {
    expect(parse(['@acme/devboard', '--board', '--chip', 'esp32s3'])).toEqual({
      name: '@acme/devboard',
      board: true,
      chip: 'esp32s3',
    })
  })
})
