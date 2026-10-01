import {describe, expect, test} from 'vitest'

import {secretInputStep} from '../secretInput.js'

/** The value after each chunk in turn, or the final value once one ends it. */
function type(...chunks: string[]): {buf: string} | {done: string} {
  let step: {buf: string} | {done: string} = {buf: ''}
  for (const chunk of chunks) {
    if ('done' in step) break
    step = secretInputStep(step.buf, chunk)
  }
  return step
}

describe('secret prompt input', () => {
  test('Enter ends it with what was typed', () => {
    expect(type('a', 'b', '\r')).toEqual({done: 'ab'})
    expect(type('a', '\n')).toEqual({done: 'a'})
  })

  test('backspace removes the last character', () => {
    expect(type('a', 'b', '\x7f')).toEqual({buf: 'a'})
    expect(type('\x7f')).toEqual({buf: ''})
  })

  test('Ctrl+C, Ctrl+D and Ctrl+Q leave with no value', () => {
    for (const exit of ['\x03', '\x04', '\x11']) {
      expect(type('s', 'e', exit), JSON.stringify(exit)).toEqual({done: ''})
    }
  })

  test('other control keys and escape sequences stay out of the value', () => {
    // Ctrl+R, an arrow key, a tab
    expect(type('a', '\x12', '\x1b[A', '\t', 'b')).toEqual({buf: 'ab'})
  })

  test('a paste is taken whole, without the control characters in it', () => {
    expect(type('pass word\r\n')).toEqual({buf: 'pass word'})
  })
})
