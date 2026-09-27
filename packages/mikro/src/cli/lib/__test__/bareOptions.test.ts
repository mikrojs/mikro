import {describe, expect, it} from 'vitest'

import {bareOptions} from '../bareOptions.js'

describe('bareOptions', () => {
  it('asks for the board for a bare --board of fw build and fw pack', () => {
    expect(bareOptions(['fw', 'build', '--board'])).toEqual(['fw', 'build', '--board='])
    expect(bareOptions(['fw', 'pack', '--board', '--parallel', '4'])).toEqual([
      'fw',
      'pack',
      '--board=',
      '--parallel',
      '4',
    ])
  })

  it('asks for the image for a bare --image of fw build', () => {
    expect(bareOptions(['fw', 'build', '--image'])).toEqual(['fw', 'build', '--image='])
    expect(bareOptions(['fw', 'build', '--image', '--board'])).toEqual([
      'fw',
      'build',
      '--image=',
      '--board=',
    ])
  })

  it('leaves options with a value, and other commands, alone', () => {
    expect(bareOptions(['fw', 'build', '--board', 'devkit', '--image', 'no-ble'])).toEqual([
      'fw',
      'build',
      '--board',
      'devkit',
      '--image',
      'no-ble',
    ])
    expect(bareOptions(['fw', 'pack', '--image'])).toEqual(['fw', 'pack', '--image'])
    expect(bareOptions(['flash', '--board'])).toEqual(['flash', '--board'])
    expect(bareOptions(['fw', 'check', '--board'])).toEqual(['fw', 'check', '--board'])
  })
})
