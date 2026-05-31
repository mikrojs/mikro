import {describe, expect, it} from 'vitest'

import {deviceIdFromSerial} from '../deviceId.js'

describe('deviceIdFromSerial', () => {
  // Regression vector cross-checked against the firmware's esp32_get_device_id()
  // (platform_esp32.cpp). Changing this means host and device ids would disagree.
  it('matches the firmware encoding for a known MAC', () => {
    expect(deviceIdFromSerial('54:32:04:22:7B:D4')).toBe('2m68224yym')
  })

  it('is case- and separator-insensitive', () => {
    expect(deviceIdFromSerial('543204227bd4')).toBe('2m68224yym')
    expect(deviceIdFromSerial('54-32-04-22-7b-d4')).toBe('2m68224yym')
  })

  it('always produces 10 lowercase Crockford-Base32 chars', () => {
    const id = deviceIdFromSerial('00:11:22:33:44:55')
    expect(id).toMatch(/^[0123456789abcdefghjkmnpqrstvwxyz]{10}$/)
  })

  it('returns undefined for non-MAC serials', () => {
    expect(deviceIdFromSerial('0001')).toBeUndefined()
    expect(deviceIdFromSerial('ABCDEF')).toBeUndefined()
    expect(deviceIdFromSerial(undefined)).toBeUndefined()
    expect(deviceIdFromSerial('')).toBeUndefined()
  })
})
