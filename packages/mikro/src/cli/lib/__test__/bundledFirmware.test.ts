import {describe, expect, it} from 'vitest'

import {customFirmwareOf, genericBoardOf} from '../bundledFirmware.js'

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

describe('genericBoardOf', () => {
  const generic = {fw: 'esp32c6-generic', chip: 'esp32c6'}

  it('is the board a device on the generic firmware was flashed as', () => {
    expect(genericBoardOf({...generic, board: '@acme/boards/xiao'}, 'esp32c6-generic')).toEqual({
      name: '@acme/boards/xiao',
      firmware: 'esp32c6-generic',
    })
  })

  it('is undefined for the plain generic firmware, a board image and legacy firmware', () => {
    expect(
      genericBoardOf({...generic, board: 'esp32c6-generic'}, 'esp32c6-generic'),
    ).toBeUndefined()
    expect(
      genericBoardOf({fw: '@acme/knob', board: '@acme/knob', chip: 'esp32s3'}, 'esp32s3-generic'),
    ).toBeUndefined()
    expect(
      genericBoardOf({board: 'esp32c6-generic', chip: 'esp32c6'}, 'esp32c6-generic'),
    ).toBeUndefined()
  })
})
