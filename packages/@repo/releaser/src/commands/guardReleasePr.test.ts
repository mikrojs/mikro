import {describe, expect, test} from 'vitest'

import {addCaution, removeCaution} from './guardReleasePr.js'

const BODY = '## Release v0.15.0\n\n- feat: things'

describe('guard-release-pr body transforms', () => {
  test('addCaution prepends the notice, removeCaution restores the original', () => {
    const withCaution = addCaution(BODY)
    expect(withCaution).toMatch(/^> \[!CAUTION\]/)
    expect(withCaution).toContain(BODY)
    expect(removeCaution(withCaution)).toBe(BODY)
  })

  test('both transforms are idempotent', () => {
    const withCaution = addCaution(BODY)
    expect(addCaution(withCaution)).toBe(withCaution)
    expect(removeCaution(BODY)).toBe(BODY)
    expect(removeCaution(removeCaution(withCaution))).toBe(BODY)
  })

  test('handles an empty body', () => {
    const withCaution = addCaution('')
    expect(withCaution).toMatch(/^> \[!CAUTION\]/)
    expect(removeCaution(withCaution)).toBe('')
  })
})
