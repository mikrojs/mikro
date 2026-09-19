import {describe, expect, it} from 'vitest'

import type {BuildFeatures} from '../build.js'
import {agentFeatures, formatFeaturesLine, missingFeaturesError} from '../featureGate.js'

function features(over: Partial<BuildFeatures> = {}): BuildFeatures {
  return {imported: [], floor: [], optional: [], modules: {}, ...over}
}

describe('formatFeaturesLine', () => {
  it('lists imported and floor features', () => {
    expect(formatFeaturesLine(features({imported: ['wifi'], floor: ['ble']}))).toBe(
      'features: wifi (imported), ble (from config)',
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
      [
        "This app needs a firmware feature that the connected device's current firmware does not support:",
        '',
        '  - ble: imported as mikro/ble',
        '',
        'The device currently runs the esp32c6-generic firmware.',
        'To deploy this app, flash the generic esp32c6 firmware, which includes ble:',
        '',
        '  mikro flash',
      ].join('\n'),
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
    expect(message).toBe(
      [
        "This app needs firmware features that the connected device's current firmware does not support:",
        '',
        '  - wifi: imported as mikro/wifi, mikro/http/server',
        '  - ble: imported as mikro/ble',
        '',
        'The device currently runs the esp32c6-generic firmware.',
        'To deploy this app, flash the generic esp32c6 firmware, which includes wifi and ble:',
        '',
        '  mikro flash',
      ].join('\n'),
    )
  })

  it('tells custom firmware to rebuild instead of flashing the bundled build over it', () => {
    const message = missingFeaturesError(features({imported: ['ble'], modules: {ble: ['ble']}}), {
      ...ready,
      fw: 'my-firmware',
    })
    expect(message).toContain(
      [
        'The device currently runs custom firmware "my-firmware".',
        'To deploy this app, rebuild that firmware with ble, then flash it:',
        '',
        '  mikro flash --build-dir <your-firmware-build>',
      ].join('\n'),
    )
    expect(message!.endsWith('  mikro flash')).toBe(false)
  })

  it('errors on a config floor feature the device lacks', () => {
    const message = missingFeaturesError(features({floor: ['ble'], optional: ['ble']}), ready)
    expect(message).toContain('  - ble: listed under features in mikro.config.ts')
    expect(message).toContain('flash the generic esp32c6 firmware, which includes ble:')
  })

  it('passes when the device has every floor feature', () => {
    expect(missingFeaturesError(features({floor: ['wifi']}), ready)).toBeUndefined()
  })

  it('reports missing imports and missing floor features together', () => {
    const message = missingFeaturesError(
      features({imported: ['ble'], floor: ['i2s'], modules: {ble: ['ble']}}),
      ready,
    )
    expect(message).toContain('  - ble: imported as mikro/ble')
    expect(message).toContain('  - i2s: listed under features in mikro.config.ts')
    expect(message).toContain('flash the generic esp32c6 firmware, which includes ble and i2s:')
  })

  it('never gates on dynamic-only (optional) features', () => {
    expect(
      missingFeaturesError(features({optional: ['ble']}), {...ready, features: []}),
    ).toBeUndefined()
  })
})
