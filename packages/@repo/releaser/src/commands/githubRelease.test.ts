import {describe, expect, test} from 'vitest'

import {extractChangelogSection} from './githubRelease.js'

const SAMPLE = `# Changelog

## 0.3.0 (2026-05-01)

### Features

- next thing ([abcd](url))

## 0.2.0 (2026-04-27)

### Features

- previous thing ([1234](url))

### Bug fixes

- fix one ([5678](url))

## 0.1.0 (2026-04-20)

### Features

- much earlier ([99aa](url))
`

describe('extractChangelogSection', () => {
  test('extracts the section between matching heading and the next ##', () => {
    const out = extractChangelogSection(SAMPLE, '0.2.0')
    expect(out).toContain('### Features')
    expect(out).toContain('previous thing')
    expect(out).toContain('### Bug fixes')
    expect(out).toContain('fix one')
    expect(out).not.toContain('much earlier')
    expect(out).not.toContain('next thing')
  })

  test('skips the section heading itself (release page already shows version)', () => {
    const out = extractChangelogSection(SAMPLE, '0.2.0')
    expect(out).not.toContain('## 0.2.0')
  })

  test('matches heading with date suffix', () => {
    const out = extractChangelogSection(SAMPLE, '0.3.0')
    expect(out).toContain('next thing')
  })

  test('matches heading without date suffix', () => {
    const noDate = `## 0.5.0\n\n### Features\n\n- bare\n`
    const out = extractChangelogSection(noDate, '0.5.0')
    expect(out).toContain('bare')
  })

  test('returns empty string when version is not present', () => {
    const out = extractChangelogSection(SAMPLE, '9.9.9')
    expect(out).toBe('')
  })

  test('does not partially match similar version prefixes', () => {
    // 0.2.0 should NOT match 0.2.0-pr-1 etc., and vice versa.
    const tricky = `## 0.2.0-pr-14 (2026-04-27)\n\n- preview\n\n## 0.2.0 (2026-04-26)\n\n- stable\n`
    const stable = extractChangelogSection(tricky, '0.2.0')
    expect(stable).toContain('stable')
    expect(stable).not.toContain('preview')
  })

  test('escapes dots in version regex (1.2.3 must not match 1x2x3)', () => {
    // Regression guard: if the regex didn't escape dots, "1.2.3" would also
    // match "1X2X3" in heading text. Confirm escaping holds.
    const tricky = `## 1X2X3\n\n- weird\n\n## 1.2.3\n\n- right\n`
    const out = extractChangelogSection(tricky, '1.2.3')
    expect(out).toContain('right')
    expect(out).not.toContain('weird')
  })
})
