import {describe, expect, it} from 'vitest'

import type {BleError} from '../types.js'
import {
  ADV_PAYLOAD_MAX,
  computeAdvertisingPayloadSize,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  validateInterval,
} from '../validators.js'

const factory = {
  InvalidInterval: (min: number, max: number): BleError => ({
    name: 'InvalidInterval' as const,
    min,
    max,
  }),
  AdvertisingPayloadTooLarge: (bytes: number, max: number): BleError => ({
    name: 'AdvertisingPayloadTooLarge' as const,
    bytes,
    max,
  }),
}

describe('validateInterval', () => {
  it('returns undefined when interval is omitted', () => {
    expect(validateInterval(undefined, factory)).toBeUndefined()
  })

  it('accepts a valid interval', () => {
    expect(validateInterval({min: 100, max: 150}, factory)).toBeUndefined()
  })

  it('accepts the exact spec minimum', () => {
    expect(validateInterval({min: MIN_INTERVAL_MS, max: MIN_INTERVAL_MS}, factory)).toBeUndefined()
  })

  it('accepts the exact spec maximum', () => {
    expect(validateInterval({min: MAX_INTERVAL_MS, max: MAX_INTERVAL_MS}, factory)).toBeUndefined()
  })

  it('rejects min below spec floor', () => {
    const result = validateInterval({min: 10, max: 100}, factory)
    expect(result).toEqual({name: 'InvalidInterval', min: 10, max: 100})
  })

  it('rejects max above spec ceiling', () => {
    const result = validateInterval({min: 100, max: 20000}, factory)
    expect(result).toEqual({name: 'InvalidInterval', min: 100, max: 20000})
  })

  it('rejects inverted range (min > max)', () => {
    const result = validateInterval({min: 200, max: 100}, factory)
    expect(result).toEqual({name: 'InvalidInterval', min: 200, max: 100})
  })

  it('rejects NaN values', () => {
    const result = validateInterval({min: Number.NaN, max: 200}, factory)
    expect(result).toEqual({name: 'InvalidInterval', min: Number.NaN, max: 200})
  })

  it('rejects Infinity values', () => {
    const result = validateInterval({min: 100, max: Number.POSITIVE_INFINITY}, factory)
    expect(result?.name).toBe('InvalidInterval')
  })
})

describe('computeAdvertisingPayloadSize', () => {
  it('counts the flags field (3 bytes) when given empty options and empty name', () => {
    expect(computeAdvertisingPayloadSize({}, 0)).toBe(3)
  })

  it('adds 2 + nameLen for a name', () => {
    // 3 (flags) + 2 (name header) + 7 (name bytes) = 12
    expect(computeAdvertisingPayloadSize({name: 'mikrojs'}, 0)).toBe(12)
  })

  it('uses fallback name length when name is omitted', () => {
    // 3 (flags) + 2 (name header) + 14 ("mikrojs-abcdef") = 19
    expect(computeAdvertisingPayloadSize({}, 14)).toBe(19)
  })

  it('adds 3 bytes when includeTxPower is true', () => {
    // 3 (flags) + 3 (tx power) + 2 (name header) + 0 (no name) = 8
    expect(computeAdvertisingPayloadSize({includeTxPower: true}, 0)).toBe(6)
  })

  it('adds 2 + data length for manufacturer data', () => {
    // 3 (flags) + 2 + 5 = 10
    expect(computeAdvertisingPayloadSize({manufacturerData: new Uint8Array(5)}, 0)).toBe(10)
  })

  it('sums all fields correctly for a realistic beacon', () => {
    // 3 (flags)
    // + 2 + 15 (name "mikrojs-beacon" = 14 chars, but we fall back to 14)
    //   Actually name is provided: 14 chars
    // + 3 (tx power)
    // + 2 + 4 (mfr data)
    // = 28
    expect(
      computeAdvertisingPayloadSize(
        {
          name: 'mikrojs-beacon',
          includeTxPower: true,
          manufacturerData: new Uint8Array(4),
        },
        0,
      ),
    ).toBe(28)
  })

  it('returns a size that exceeds ADV_PAYLOAD_MAX for oversized payloads', () => {
    // 3 + 2 + 20 + 2 + 10 = 37
    const size = computeAdvertisingPayloadSize(
      {
        name: 'this-is-a-very-long-',
        manufacturerData: new Uint8Array(10),
      },
      0,
    )
    expect(size).toBeGreaterThan(ADV_PAYLOAD_MAX)
  })
})
