import {describe, expect, it} from 'vitest'

import {formatSize} from '../formatSize.js'

describe('formatSize', () => {
  it('counts in binary units, matching flash and heap figures', () => {
    // 1024, not 1000: an SI size would not line up with the partition and heap
    // numbers it gets compared against.
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
  })

  it('stays in bytes below the first unit boundary', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1023)).toBe('1023 B')
  })
})
