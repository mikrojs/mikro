import {describe, expect, test} from 'vitest'

import type {ParsedCommit} from './commits.js'
import {recommendBump} from './version.js'

function commit(overrides: Partial<ParsedCommit> = {}): ParsedCommit {
  return {
    type: 'chore',
    scope: null,
    subject: 'do something',
    breaking: false,
    header: 'chore: do something',
    body: null,
    hash: 'abcdef1234567890',
    shortHash: 'abcdef1',
    prNumber: null,
    ...overrides,
  }
}

describe('recommendBump', () => {
  test('breaking change → major', () => {
    expect(recommendBump([commit(), commit({type: 'feat', breaking: true})])).toBe('major')
  })

  test('feat without breaking → minor', () => {
    expect(recommendBump([commit(), commit({type: 'feat'})])).toBe('minor')
  })

  test('fixes and chores only → patch', () => {
    expect(recommendBump([commit(), commit({type: 'fix'})])).toBe('patch')
  })

  test('empty range → patch', () => {
    expect(recommendBump([])).toBe('patch')
  })
})
