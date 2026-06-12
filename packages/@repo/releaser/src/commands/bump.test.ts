import semver from 'semver'
import {describe, expect, test} from 'vitest'

import {type BumpInputs, computeBumpPure} from './bump.js'

const baseInputs: BumpInputs = {
  mode: 'release',
  currentVersion: '0.2.0',
  semverIncrement: 'minor',
  git: {commitHash: 'abc1234'},
  now: new Date('2026-06-13T09:42:17Z'),
}

describe('computeBumpPure', () => {
  test('release mode increments by recommended bump', () => {
    expect(computeBumpPure({...baseInputs, mode: 'release'})).toEqual({
      version: '0.3.0',
      npmTag: 'latest',
      mode: 'release',
    })
  })

  test('release mode honors semverIncrement', () => {
    expect(computeBumpPure({...baseInputs, mode: 'release', semverIncrement: 'patch'})).toEqual({
      version: '0.2.1',
      npmTag: 'latest',
      mode: 'release',
    })
    // Default: no pre-major cap. A `feat!:` from 0.x lands 1.0.0 directly.
    expect(computeBumpPure({...baseInputs, mode: 'release', semverIncrement: 'major'})).toEqual({
      version: '1.0.0',
      npmTag: 'latest',
      mode: 'release',
    })
  })

  test('breakingIsMinorOn0x caps major→minor while on 0.x', () => {
    // Opt-in safety net for projects that want to defer the 1.0.0 cut.
    expect(
      computeBumpPure({
        ...baseInputs,
        mode: 'release',
        semverIncrement: 'major',
        breakingIsMinorOn0x: true,
      }),
    ).toEqual({
      version: '0.3.0',
      npmTag: 'latest',
      mode: 'release',
    })
  })

  test('breakingIsMinorOn0x is a no-op once on 1.x or later', () => {
    expect(
      computeBumpPure({
        ...baseInputs,
        mode: 'release',
        currentVersion: '1.4.2',
        semverIncrement: 'major',
        breakingIsMinorOn0x: true,
      }),
    ).toEqual({
      version: '2.0.0',
      npmTag: 'latest',
      mode: 'release',
    })
  })

  test('--use-current returns currentVersion verbatim, no increment', () => {
    // The bug C1 we are guarding against: release.yml runs bump after the
    // release PR has already bumped package.json to 0.2.0. We must publish
    // 0.2.0, not 0.3.0.
    expect(
      computeBumpPure({
        ...baseInputs,
        mode: 'release',
        useCurrent: true,
        currentVersion: '0.2.0',
        semverIncrement: 'minor',
      }),
    ).toEqual({
      version: '0.2.0',
      npmTag: 'latest',
      mode: 'release',
    })
  })

  test('--use-current rejects non-release modes', () => {
    expect(() => computeBumpPure({...baseInputs, mode: 'canary', useCurrent: true})).toThrow(
      /--use-current is only valid with --mode=release/,
    )
  })

  test('release-preview mode: prerelease of the already-bumped version, next tag', () => {
    // No double-bump: the release PR already bumped to 0.10.0, so the preview
    // stays on 0.10.0 (not 0.11.0) and publishes under `next`.
    expect(
      computeBumpPure({
        ...baseInputs,
        mode: 'release-preview',
        currentVersion: '0.10.0',
        semverIncrement: 'minor',
      }),
    ).toEqual({
      version: '0.10.0-next.20260613094217+abc1234',
      mode: 'release-preview',
      npmTag: 'next',
    })
  })

  test('canary mode appends timestamp and +sha build metadata', () => {
    expect(computeBumpPure({...baseInputs, mode: 'canary'})).toEqual({
      version: '0.3.0-canary.20260613094217+abc1234',
      npmTag: 'canary',
      mode: 'canary',
    })
  })

  test('pr-preview mode embeds PR number, timestamp, and +sha build metadata', () => {
    expect(computeBumpPure({...baseInputs, mode: 'pr-preview', pr: 121})).toEqual({
      version: '0.3.0-pr-121.20260613094217+abc1234',
      npmTag: 'pr-121',
      mode: 'pr-preview',
    })
  })

  test('successive prerelease builds sort monotonically under semver.compare', () => {
    // The numeric timestamp segment orders publishes by publish time; the
    // +sha build metadata is ignored by semver precedence (the shas here are
    // deliberately in reverse lexical order).
    const older = computeBumpPure({
      ...baseInputs,
      mode: 'pr-preview',
      pr: 121,
      git: {commitHash: 'fffffff'},
      now: new Date('2026-06-13T09:42:17Z'),
    })
    const newer = computeBumpPure({
      ...baseInputs,
      mode: 'pr-preview',
      pr: 121,
      git: {commitHash: 'aaaaaaa'},
      now: new Date('2026-06-13T09:42:18Z'),
    })
    expect(semver.compare(older.version, newer.version)).toBe(-1)
    // And every pr-preview sorts below the release it previews.
    expect(semver.compare(newer.version, '0.3.0')).toBe(-1)
  })

  test('pr-preview without --pr throws', () => {
    expect(() => computeBumpPure({...baseInputs, mode: 'pr-preview'})).toThrow(
      /--mode=pr-preview requires --pr/,
    )
  })
})
