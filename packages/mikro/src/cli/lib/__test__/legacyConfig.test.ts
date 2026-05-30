import {describe, expect, it} from 'vitest'

import {assertNoLegacyMikroConfig} from '../legacyConfig.js'

describe('assertNoLegacyMikroConfig', () => {
  it('passes when no legacy "mikrojs" key is present', () => {
    expect(() => assertNoLegacyMikroConfig({}, 'package.json')).not.toThrow()
    expect(() =>
      assertNoLegacyMikroConfig({mikro: {predeploy: 'tsc'}} as {mikrojs?: unknown}, 'package.json'),
    ).not.toThrow()
  })

  it('throws with migration guidance when the legacy "mikrojs" key is present', () => {
    expect(() => assertNoLegacyMikroConfig({mikrojs: {predeploy: 'tsc'}}, 'package.json')).toThrow(
      /"mikrojs" config key in package\.json was renamed to "mikro"/,
    )
  })

  it('names the source in the error', () => {
    expect(() => assertNoLegacyMikroConfig({mikrojs: {}}, 'dependency "some-board"')).toThrow(
      /dependency "some-board"/,
    )
  })

  it('throws even when the legacy key is null (key present)', () => {
    expect(() => assertNoLegacyMikroConfig({mikrojs: null}, 'package.json')).toThrow()
  })
})
