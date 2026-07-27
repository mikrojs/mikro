import {describe, expect, it} from 'vitest'

import {customFirmwareOf} from '../bundledFirmware.js'

describe('customFirmwareOf', () => {
  it('treats a device reporting no identity as the bundled firmware (legacy)', () => {
    expect(customFirmwareOf({chip: 'esp32c6'}, '@mikrojs/firmware-dev')).toBeUndefined()
  })

  it('treats an identity matching the bundled prebuilt as bundled', () => {
    expect(
      customFirmwareOf({fw: '@mikrojs/firmware-dev', chip: 'esp32c6'}, '@mikrojs/firmware-dev'),
    ).toBeUndefined()
  })

  it('returns the identity when it differs from the bundled name', () => {
    expect(customFirmwareOf({fw: 'acme-sensor-fw', chip: 'esp32c6'}, '@mikrojs/firmware-dev')).toBe(
      'acme-sensor-fw',
    )
  })

  it('counts an identity as custom when no bundled name is recorded', () => {
    expect(customFirmwareOf({fw: 'acme-sensor-fw', chip: 'esp32c6'}, undefined)).toBe(
      'acme-sensor-fw',
    )
  })

  it('counts an identity as custom when the chip is unknown', () => {
    // Default bundledName path: no chip means no prebuilt lookup, so no match.
    expect(customFirmwareOf({fw: 'acme-sensor-fw', chip: null})).toBe('acme-sensor-fw')
  })
})
