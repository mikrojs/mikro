import {describe, expect, it} from 'vitest'

import {validateDeviceName} from '../deviceName.js'
import {suggestDeviceName} from '../suggestName.js'

describe('suggestDeviceName', () => {
  it('is deterministic for a given seed', () => {
    expect(suggestDeviceName('2m68224yym')).toBe(suggestDeviceName('2m68224yym'))
  })

  // Against the real validator rather than a copy of its regex: a derived name
  // that `mikro name set` would reject is only useful for producing errors.
  it('produces a color-animal name the device-name validator accepts', () => {
    const name = suggestDeviceName('2m68224yym')
    expect(name).toMatch(/^[a-z]+-[a-z]+$/)
    expect(validateDeviceName(name)).toEqual({ok: true})
  })

  it('varies across different seeds', () => {
    const names = new Set(
      ['a', 'b', 'c', 'd', 'e', '2m68224yym', '0011223344', 'S1', 'S2', 'S3'].map(
        suggestDeviceName,
      ),
    )
    // Not a strict guarantee, but collisions across 10 distinct seeds should be rare.
    expect(names.size).toBeGreaterThan(7)
  })
})
