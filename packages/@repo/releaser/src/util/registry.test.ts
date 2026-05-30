import {describe, expect, test} from 'vitest'

import {packageVersionUrl} from './registry.js'

const REG = 'https://registry.npmjs.org'

describe('packageVersionUrl', () => {
  test('unscoped package', () => {
    expect(packageVersionUrl(REG, 'mikro', '0.10.0')).toBe(`${REG}/mikro/0.10.0`)
  })

  test('scoped package URL-encodes the @ and slash', () => {
    expect(packageVersionUrl(REG, '@mikrojs/native', '0.10.0-next.7.gabc1234')).toBe(
      `${REG}/%40mikrojs%2Fnative/0.10.0-next.7.gabc1234`,
    )
  })

  test('trims trailing slashes from the registry base', () => {
    expect(packageVersionUrl('https://r.example.com//', 'mikro', '1.0.0')).toBe(
      'https://r.example.com/mikro/1.0.0',
    )
  })
})
