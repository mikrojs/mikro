import {describe, expect, test} from 'vitest'

import {parseCommit} from './commits.js'

const HASH = '0123456789abcdef0123456789abcdef01234567'
const SHORT = '0123456'

describe('parseCommit', () => {
  test('parses plain conventional header', () => {
    const c = parseCommit(HASH, SHORT, 'feat(cli): add a flag')
    expect(c.type).toBe('feat')
    expect(c.scope).toBe('cli')
    expect(c.subject).toBe('add a flag')
    expect(c.breaking).toBe(false)
  })

  test('parses bang as breaking change (Conventional Commits v1.0.0)', () => {
    const c = parseCommit(HASH, SHORT, 'feat(cli)!: make env vars secret by default')
    expect(c.type).toBe('feat')
    expect(c.scope).toBe('cli')
    expect(c.subject).toBe('make env vars secret by default')
    expect(c.breaking).toBe(true)
  })

  test('parses bang without scope', () => {
    const c = parseCommit(HASH, SHORT, 'feat!: drop deprecated api')
    expect(c.type).toBe('feat')
    expect(c.scope).toBeNull()
    expect(c.breaking).toBe(true)
  })

  test('parses BREAKING CHANGE footer', () => {
    const c = parseCommit(
      HASH,
      SHORT,
      'feat(cli): rename flag\n\nBREAKING CHANGE: --foo is now --bar',
    )
    expect(c.breaking).toBe(true)
  })

  test('strips trailing PR number from subject', () => {
    const c = parseCommit(HASH, SHORT, 'fix(wifi): retry on brownout (#123)')
    expect(c.subject).toBe('retry on brownout')
    expect(c.prNumber).toBe(123)
  })

  test('non-conventional message yields null type', () => {
    const c = parseCommit(HASH, SHORT, 'random commit message')
    expect(c.type).toBeNull()
  })
})
