import {afterEach, describe, expect, test, vi} from 'vitest'

import {formatChangelog} from './changelogFormat.js'
import type {ParsedCommit} from './commits.js'

function commit(overrides: Partial<ParsedCommit>): ParsedCommit {
  return {
    type: 'feat',
    scope: null,
    subject: 'do a thing',
    breaking: false,
    header: 'feat: do a thing',
    body: null,
    hash: '0123456789abcdef0123456789abcdef01234567',
    shortHash: '0123456',
    prNumber: null,
    ...overrides,
  }
}

describe('formatChangelog', () => {
  // Default: no GITHUB_REPOSITORY. Individual tests stub it; afterEach restores.
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('empty input returns "no notable changes"', () => {
    expect(formatChangelog([])).toMatch(/No notable changes/)
  })

  test('non-conventional commits are skipped', () => {
    const commits = [commit({type: null, subject: 'random non-conventional message'})]
    expect(formatChangelog(commits)).toMatch(/No notable changes/)
  })

  test('groups by section in the canonical order', () => {
    const out = formatChangelog([
      commit({type: 'fix', subject: 'fix the bug'}),
      commit({type: 'feat', subject: 'add the feature'}),
      commit({type: 'chore', subject: 'tidy up'}),
    ])
    const featIdx = out.indexOf('Features')
    const fixIdx = out.indexOf('Bug fixes')
    const otherIdx = out.indexOf('Other')
    expect(featIdx).toBeGreaterThan(-1)
    expect(fixIdx).toBeGreaterThan(featIdx)
    expect(otherIdx).toBeGreaterThan(fixIdx)
  })

  test('breaking changes get their own section, ahead of features', () => {
    const out = formatChangelog([
      commit({type: 'feat', breaking: true, subject: 'big change'}),
      commit({type: 'feat', subject: 'small change'}),
    ])
    expect(out.indexOf('Breaking changes')).toBeLessThan(out.indexOf('Features'))
    // Breaking commit appears in the Breaking section, not in Features.
    const breakingSection = out.slice(out.indexOf('Breaking changes'), out.indexOf('Features'))
    expect(breakingSection).toContain('big change')
    expect(breakingSection).not.toContain('small change')
  })

  test('renders scope as bold prefix', () => {
    const out = formatChangelog([commit({type: 'feat', scope: 'cli', subject: 'new flag'})])
    expect(out).toContain('**cli:** new flag')
  })

  test('uses PR number for ref when available', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'mikrojs/mikrojs')
    const out = formatChangelog([commit({type: 'feat', subject: 'thing', prNumber: 42})])
    expect(out).toContain('([#42](https://github.com/mikrojs/mikrojs/pull/42))')
  })

  test('falls back to short hash when no PR number', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'mikrojs/mikrojs')
    const out = formatChangelog([commit({type: 'feat', subject: 'thing', prNumber: null})])
    expect(out).toContain(
      '([0123456](https://github.com/mikrojs/mikrojs/commit/0123456789abcdef0123456789abcdef01234567))',
    )
  })

  test('omits links when GITHUB_REPOSITORY is not set', () => {
    vi.stubEnv('GITHUB_REPOSITORY', '')
    const out = formatChangelog([commit({type: 'feat', subject: 'thing', prNumber: 42})])
    expect(out).toContain('(#42)')
    expect(out).not.toContain('https://github.com')
  })

  test('skips empty sections', () => {
    const out = formatChangelog([commit({type: 'feat', subject: 'thing'})])
    expect(out).toContain('Features')
    expect(out).not.toContain('Bug fixes')
    expect(out).not.toContain('Performance')
  })
})
