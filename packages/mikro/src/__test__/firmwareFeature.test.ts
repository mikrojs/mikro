import modulesJson from '@mikrojs/native/runtime/modules.json' with {type: 'json'}
import {describe, expect, it} from 'vitest'

import type {FirmwareFeature} from '../_exports/index.js'

// Compile-time exhaustiveness both ways: `satisfies` rejects values outside
// the union, the Record rejects a union member missing from the list.
const DECLARED = ['wifi', 'ble', 'i2s'] as const satisfies readonly FirmwareFeature[]
const _allListed: Record<FirmwareFeature, true> = {wifi: true, ble: true, i2s: true}
void _allListed

describe('FirmwareFeature', () => {
  it('matches the feature gates declared in modules.json', () => {
    const gates = new Set(
      modulesJson.modules
        .map((m) => ('feature' in m ? m.feature : undefined))
        .filter((f) => f !== undefined),
    )
    expect(new Set(DECLARED)).toEqual(gates)
  })
})
