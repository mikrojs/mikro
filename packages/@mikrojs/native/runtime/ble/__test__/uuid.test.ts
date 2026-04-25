import {describe, expect, it} from 'vitest'

import {parseUuid, uuidsEqual} from '../uuid.js'

describe('parseUuid', () => {
  describe('16-bit shorthand', () => {
    it('parses lowercase 4-char hex', () => {
      const result = parseUuid('180f')
      expect(result).toEqual({kind: 16, value: 0x180f, normalized: '180f'})
    })

    it('parses uppercase and normalizes to lowercase', () => {
      const result = parseUuid('180F')
      expect(result).toEqual({kind: 16, value: 0x180f, normalized: '180f'})
    })

    it('parses mixed case', () => {
      const result = parseUuid('aBcD')
      expect(result).toEqual({kind: 16, value: 0xabcd, normalized: 'abcd'})
    })

    it('accepts all zeros', () => {
      const result = parseUuid('0000')
      expect(result).toEqual({kind: 16, value: 0, normalized: '0000'})
    })

    it('accepts the full uint16 range', () => {
      const result = parseUuid('ffff')
      expect(result).toEqual({kind: 16, value: 0xffff, normalized: 'ffff'})
    })

    it('rejects 3 chars', () => {
      expect(parseUuid('180')).toBeNull()
    })

    it('rejects 5 chars', () => {
      expect(parseUuid('180f0')).toBeNull()
    })

    it('rejects non-hex chars', () => {
      expect(parseUuid('180z')).toBeNull()
    })
  })

  describe('128-bit canonical form', () => {
    it('parses the standard form', () => {
      const result = parseUuid('6e400001-b5a3-f393-e0a9-e50e24dcca9e')
      expect(result?.kind).toBe(128)
      if (result?.kind !== 128) throw new Error('unreachable')
      expect(result.normalized).toBe('6e400001-b5a3-f393-e0a9-e50e24dcca9e')
      expect(Array.from(result.bytes)).toEqual([
        0x6e, 0x40, 0x00, 0x01, 0xb5, 0xa3, 0xf3, 0x93, 0xe0, 0xa9, 0xe5, 0x0e, 0x24, 0xdc, 0xca,
        0x9e,
      ])
    })

    it('normalizes uppercase to lowercase', () => {
      const result = parseUuid('6E400001-B5A3-F393-E0A9-E50E24DCCA9E')
      expect(result?.normalized).toBe('6e400001-b5a3-f393-e0a9-e50e24dcca9e')
    })

    it('parses the Bluetooth SIG base UUID', () => {
      const result = parseUuid('00000000-0000-1000-8000-00805f9b34fb')
      expect(result?.kind).toBe(128)
      if (result?.kind !== 128) throw new Error('unreachable')
      expect(Array.from(result.bytes)).toEqual([
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0x80, 0x5f, 0x9b, 0x34,
        0xfb,
      ])
    })

    it('rejects missing dashes', () => {
      expect(parseUuid('6e400001b5a3f393e0a9e50e24dcca9e')).toBeNull()
    })

    it('rejects wrong dash positions', () => {
      expect(parseUuid('6e400001-b5a3f393-e0a9-e50e24dcca9e')).toBeNull()
    })

    it('rejects too-short hex groups', () => {
      expect(parseUuid('6e40001-b5a3-f393-e0a9-e50e24dcca9e')).toBeNull()
    })

    it('rejects non-hex characters in groups', () => {
      expect(parseUuid('6e400001-b5a3-f393-e0a9-e50e24dcca9z')).toBeNull()
    })
  })

  describe('rejection', () => {
    it('rejects empty string', () => {
      expect(parseUuid('')).toBeNull()
    })

    it('rejects whitespace', () => {
      expect(parseUuid('  ')).toBeNull()
    })

    it('rejects leading whitespace on valid 16-bit', () => {
      expect(parseUuid(' 180f')).toBeNull()
    })

    it('rejects trailing whitespace on valid 128-bit', () => {
      expect(parseUuid('6e400001-b5a3-f393-e0a9-e50e24dcca9e ')).toBeNull()
    })

    it('rejects non-string input', () => {
      expect(parseUuid(0x180f)).toBeNull()
      expect(parseUuid(null)).toBeNull()
      expect(parseUuid(undefined)).toBeNull()
      expect(parseUuid({})).toBeNull()
    })
  })
})

describe('uuidsEqual', () => {
  it('returns true for identical 16-bit UUIDs', () => {
    const a = parseUuid('180f')!
    const b = parseUuid('180F')!
    expect(uuidsEqual(a, b)).toBe(true)
  })

  it('returns false for different 16-bit UUIDs', () => {
    const a = parseUuid('180f')!
    const b = parseUuid('2a19')!
    expect(uuidsEqual(a, b)).toBe(false)
  })

  it('returns true for identical 128-bit UUIDs with different case', () => {
    const a = parseUuid('6e400001-b5a3-f393-e0a9-e50e24dcca9e')!
    const b = parseUuid('6E400001-B5A3-F393-E0A9-E50E24DCCA9E')!
    expect(uuidsEqual(a, b)).toBe(true)
  })

  it('returns false for 128-bit UUIDs that differ in one byte', () => {
    const a = parseUuid('6e400001-b5a3-f393-e0a9-e50e24dcca9e')!
    const b = parseUuid('6e400002-b5a3-f393-e0a9-e50e24dcca9e')!
    expect(uuidsEqual(a, b)).toBe(false)
  })

  it('returns false when comparing 16-bit and 128-bit even if conceptually equivalent', () => {
    // 0x180f expanded to the canonical form is 0000180f-0000-1000-8000-00805f9b34fb,
    // but we treat them as different at this layer — the caller decides how to
    // normalize if they care.
    const a = parseUuid('180f')!
    const b = parseUuid('0000180f-0000-1000-8000-00805f9b34fb')!
    expect(uuidsEqual(a, b)).toBe(false)
  })
})
