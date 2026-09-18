import {describe, expect, it} from 'vitest'

import type {BuildFeatures} from '../build.js'
import {agentFeatures, formatFeaturesLine, missingFeaturesError} from '../featureGate.js'

function features(over: Partial<BuildFeatures> = {}): BuildFeatures {
  return {imported: [], floor: [], optional: [], modules: {}, ...over}
}

describe('formatFeaturesLine', () => {
  it('lists imported and floor features', () => {
    expect(formatFeaturesLine(features({imported: ['wifi'], floor: ['ble']}))).toBe(
      'features: wifi (imported), ble (floor)',
    )
  })

  it('returns undefined when there is nothing to report', () => {
    expect(formatFeaturesLine(features({optional: ['ble']}))).toBeUndefined()
  })
})

describe('agentFeatures', () => {
  it('returns the compact summary without the modules map', () => {
    expect(
      agentFeatures(features({imported: ['wifi'], optional: ['ble'], modules: {wifi: ['wifi']}})),
    ).toEqual({imported: ['wifi'], floor: [], optional: ['ble']})
  })

  it('returns undefined when the build needs nothing (field omitted)', () => {
    expect(agentFeatures(features())).toBeUndefined()
    expect(agentFeatures(undefined)).toBeUndefined()
  })
})

describe('missingFeaturesError', () => {
  const ready = {chip: 'esp32c6', board: 'esp32c6-generic', features: ['wifi']}

  it('skips silently on legacy firmware (no features reported)', () => {
    expect(
      missingFeaturesError(features({imported: ['ble'], modules: {ble: ['ble']}}), {
        chip: 'esp32c6',
        board: undefined,
        features: undefined,
      }),
    ).toBeUndefined()
  })

  it('passes when the device has every required feature', () => {
    expect(
      missingFeaturesError(features({imported: ['wifi'], modules: {wifi: ['wifi']}}), ready),
    ).toBeUndefined()
  })

  it('does not warn about surplus device features', () => {
    expect(
      missingFeaturesError(features(), {...ready, features: ['wifi', 'ble', 'i2s']}),
    ).toBeUndefined()
  })

  it('errors naming the missing feature, its modules, and the firmware', () => {
    const message = missingFeaturesError(
      features({imported: ['ble'], modules: {ble: ['ble']}}),
      ready,
    )
    expect(message).toBe(
      "This app imports mikro/ble which needs the 'ble' firmware feature, " +
        "but the connected device's firmware (esp32c6-generic) does not include it.\n" +
        'Reflash with: mikro flash',
    )
  })

  it('names every missing feature with its triggering modules', () => {
    const message = missingFeaturesError(
      features({
        imported: ['wifi', 'ble'],
        modules: {wifi: ['wifi', 'http/server'], ble: ['ble']},
      }),
      {chip: 'esp32c6', board: 'esp32c6-generic', features: []},
    )
    expect(message).toContain(
      "This app imports mikro/wifi, mikro/http/server which need the 'wifi' firmware feature",
    )
    expect(message).toContain("This app imports mikro/ble which needs the 'ble' firmware feature")
    expect(message).toContain('Reflash with: mikro flash')
  })

  it('tells custom firmware to rebuild instead of flashing the bundled build over it', () => {
    const message = missingFeaturesError(features({imported: ['ble'], modules: {ble: ['ble']}}), {
      ...ready,
      fw: 'my-firmware',
    })
    expect(message).toContain(
      'The device runs custom firmware ("my-firmware"). Rebuild it with the feature enabled, ' +
        'then flash it: mikro flash --build-dir <your-firmware-build>',
    )
    expect(message).not.toContain('Reflash with: mikro flash')
  })

  it('never gates on dynamic-only (optional) features', () => {
    expect(
      missingFeaturesError(features({optional: ['ble']}), {...ready, features: []}),
    ).toBeUndefined()
  })
})
