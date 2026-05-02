import {describe, expect, test} from 'vitest'

import {type BumpInputs, computeBumpPure} from './bump.js'

const baseInputs: BumpInputs = {
  mode: 'release',
  currentVersion: '0.2.0',
  semverIncrement: 'minor',
  git: {commitHash: 'abc1234', commitCount: '7'},
  now: new Date(Date.UTC(2026, 3, 27, 12, 34, 56)),
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
    expect(() => computeBumpPure({...baseInputs, mode: 'next', useCurrent: true})).toThrow(
      /--use-current is only valid with --mode=release/,
    )
  })

  test('next mode appends commits-ahead suffix and .gsha', () => {
    expect(computeBumpPure({...baseInputs, mode: 'next'})).toEqual({
      version: '0.3.0-next.7.gabc1234',
      npmTag: 'next',
      mode: 'next',
    })
  })

  test('canary mode appends commits-ahead suffix and .gsha', () => {
    expect(computeBumpPure({...baseInputs, mode: 'canary'})).toEqual({
      version: '0.3.0-canary.7.gabc1234',
      npmTag: 'canary',
      mode: 'canary',
    })
  })

  test('pr-preview mode embeds PR number, timestamp, and sha', () => {
    expect(computeBumpPure({...baseInputs, mode: 'pr-preview', pr: 121})).toEqual({
      version: '0.3.0-pr-121.20260427123456.gabc1234',
      npmTag: 'pr-121',
      mode: 'pr-preview',
    })
  })

  test('pr-preview without --pr throws', () => {
    expect(() => computeBumpPure({...baseInputs, mode: 'pr-preview'})).toThrow(
      /--mode=pr-preview requires --pr/,
    )
  })

  test('pr-preview timestamps zero-pad correctly', () => {
    const inputs: BumpInputs = {
      ...baseInputs,
      mode: 'pr-preview',
      pr: 1,
      now: new Date(Date.UTC(2026, 0, 5, 7, 8, 9)), // Jan 5, 07:08:09 UTC
    }
    expect(computeBumpPure(inputs).version).toBe('0.3.0-pr-1.20260105070809.gabc1234')
  })
})
