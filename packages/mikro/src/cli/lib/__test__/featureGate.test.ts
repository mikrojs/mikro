import {describe, expect, it} from 'vitest'

import type {BuildFeatures, NativeNeeds} from '../build.js'
import {agentFeatures, formatFeaturesLine, missingFeaturesError} from '../featureGate.js'

function natives(over: Partial<NativeNeeds> = {}): NativeNeeds {
  return {imported: [], optional: [], owners: {}, ...over}
}

function features(over: Partial<BuildFeatures> = {}): BuildFeatures {
  return {imported: [], floor: [], optional: [], modules: {}, natives: natives(), ...over}
}

describe('formatFeaturesLine', () => {
  it('lists imported and floor features', () => {
    expect(formatFeaturesLine(features({imported: ['wifi'], floor: ['ble']}))).toBe(
      'features: wifi (imported), ble (from config)',
    )
  })

  it('lists statically imported native modules', () => {
    expect(
      formatFeaturesLine(
        features({imported: ['wifi'], natives: natives({imported: ['c6-neo/ring-fx']})}),
      ),
    ).toBe('features: wifi (imported), c6-neo/ring-fx (imported)')
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

  it('includes native modules when the build needs any', () => {
    const n = natives({imported: ['c6-neo/ring-fx'], owners: {'c6-neo/ring-fx': 'x'}})
    expect(agentFeatures(features({natives: n}))).toEqual({
      imported: [],
      floor: [],
      optional: [],
      natives: n,
    })
  })

  it('returns undefined when the build needs nothing (field omitted)', () => {
    expect(agentFeatures(features())).toBeUndefined()
    expect(agentFeatures(undefined)).toBeUndefined()
  })
})

describe('missingFeaturesError', () => {
  const ready = {chip: 'esp32c6', board: 'esp32c6-generic', features: ['wifi'], natives: []}

  it('skips silently on legacy firmware (no features reported)', () => {
    expect(
      missingFeaturesError(features({imported: ['ble'], modules: {ble: ['ble']}}), {
        chip: 'esp32c6',
        board: undefined,
        features: undefined,
        natives: undefined,
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
      {chip: 'esp32c6', board: 'esp32c6-generic', features: [], natives: []},
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

  describe('native modules', () => {
    const needsRing = features({
      natives: natives({
        imported: ['c6-neo/ring-fx'],
        owners: {'c6-neo/ring-fx': 'c6-neo/native/ring-fx'},
      }),
    })

    it('passes when the firmware was built with the module', () => {
      expect(
        missingFeaturesError(needsRing, {...ready, natives: ['c6-neo/ring-fx']}),
      ).toBeUndefined()
    })

    it('errors naming the module, its directory and the fix on firmware without it', () => {
      expect(missingFeaturesError(needsRing, ready)).toBe(
        "This app imports a native module that the device's firmware (esp32c6-generic) " +
          'was not built with:\n' +
          '  c6-neo/ring-fx (c6-neo/native/ring-fx)\n' +
          "List it in your firmware project's MIKROJS_NATIVE_MODULES, build the firmware, " +
          'and flash that build:\n' +
          '  mikro flash --build-dir <your-firmware-build>\n' +
          'To create a firmware project, see https://mikrojs.dev/develop/custom-firmware',
      )
    })

    it('lists several modules under one sentence, each named once', () => {
      const two = features({
        natives: natives({
          imported: ['ring/extra', 'ring/fx'],
          owners: {'ring/extra': 'ring/extra', 'ring/fx': 'ring/fx'},
        }),
      })
      expect(missingFeaturesError(two, ready)).toBe(
        "This app imports 2 native modules that the device's firmware (esp32c6-generic) " +
          'was not built with:\n' +
          '  ring/extra\n' +
          '  ring/fx\n' +
          "List them in your firmware project's MIKROJS_NATIVE_MODULES, build the firmware, " +
          'and flash that build:\n' +
          '  mikro flash --build-dir <your-firmware-build>\n' +
          'To create a firmware project, see https://mikrojs.dev/develop/custom-firmware',
      )
    })

    it('points custom firmware at its own project, not at creating one', () => {
      const message = missingFeaturesError(needsRing, {...ready, fw: 'my-firmware'})
      expect(message).toContain('  mikro flash --build-dir <your-firmware-build>')
      expect(message).not.toContain('To create a firmware project')
    })

    it('skips silently on firmware that does not report its native modules', () => {
      expect(missingFeaturesError(needsRing, {...ready, natives: undefined})).toBeUndefined()
    })

    it('never gates on dynamic-only native imports', () => {
      expect(
        missingFeaturesError(features({natives: natives({optional: ['c6-neo/ring-fx']})}), ready),
      ).toBeUndefined()
    })
  })
})
