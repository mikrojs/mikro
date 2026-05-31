import {describe, expect, it} from 'vitest'

import {suggestDeviceName} from '../suggestName.js'

// The alias name validator (kept in sync with deviceAliases.ts).
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

describe('suggestDeviceName', () => {
  it('is deterministic for a given seed', () => {
    expect(suggestDeviceName('2m68224yym')).toBe(suggestDeviceName('2m68224yym'))
  })

  it('produces a color-animal name that passes the alias validator', () => {
    const name = suggestDeviceName('2m68224yym')
    expect(name).toMatch(/^[a-z]+-[a-z]+$/)
    expect(name).toMatch(NAME_RE)
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
