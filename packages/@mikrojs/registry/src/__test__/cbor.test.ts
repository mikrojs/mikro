import {describe, expect, it} from 'vitest'

import {decodeCbor, encodeCbor} from '../cbor.js'

const hex = (s: string): Uint8Array =>
  new Uint8Array((s.match(/../g) ?? []).map((b) => parseInt(b, 16)))
const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('cbor', () => {
  // RFC 8949 appendix A vectors (the subset this wire uses)
  const vectors: Array<[string, unknown]> = [
    ['00', 0],
    ['0a', 10],
    ['17', 23],
    ['1818', 24],
    ['1903e8', 1000],
    ['1a000f4240', 1000000],
    ['1b000000e8d4a51000', 1000000000000],
    ['20', -1],
    ['29', -10],
    ['3903e7', -1000],
    ['f4', false],
    ['f5', true],
    ['f6', null],
    ['f7', undefined],
    ['60', ''],
    ['6161', 'a'],
    ['6449455446', 'IETF'],
    ['62c3bc', 'ü'],
    ['80', []],
    ['83010203', [1, 2, 3]],
    ['8301820203820405', [1, [2, 3], [4, 5]]],
    ['a0', {}],
    ['a26161016162820203', {a: 1, b: [2, 3]}],
    ['fb3ff199999999999a', 1.1],
  ]

  it.each(vectors)('round-trips RFC 8949 vector %s', (encoded, value) => {
    expect(decodeCbor(hex(encoded))).toEqual(value)
    expect(toHex(encodeCbor(value))).toBe(encoded)
  })

  it('decodes half and single precision floats', () => {
    expect(decodeCbor(hex('f94100'))).toBe(2.5)
    expect(decodeCbor(hex('fa47c35000'))).toBe(100000)
  })

  it('round-trips byte strings', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    expect(toHex(encodeCbor(bytes))).toBe('4401020304')
    expect(decodeCbor(hex('4401020304'))).toEqual(bytes)
  })

  it('round-trips a check-in shaped report', () => {
    const report = {
      deviceId: 'dev-1',
      firmware: '0.16.0',
      firmwareHash: 'abc',
      bytecode: 42,
      running: {checksum: 'oldsum', version: '1.0.0', trial: false},
      name: [1, 'shed'],
      free: 900_000,
      lastInstall: {reason: 'ota_install_failed', detail: 'corrupt'},
    }
    expect(decodeCbor(encodeCbor(report))).toEqual(report)
  })

  it('omits keys whose value is undefined, like JSON.stringify does', () => {
    expect(decodeCbor(encodeCbor({a: 1, b: undefined}))).toEqual({a: 1})
  })

  it('rejects what the wire never carries', () => {
    expect(() => encodeCbor(() => {})).toThrow(/cannot encode/)
    expect(() => decodeCbor(hex('c074'))).toThrow(/major type 6/) // tag
    expect(() => decodeCbor(hex('5f4401020304ff'))).toThrow() // indefinite length
    expect(() => decodeCbor(hex('a1016161'))).toThrow(/keys must be strings/)
  })

  it('rejects malformed input', () => {
    expect(() => decodeCbor(hex('1903'))).toThrow(/truncated/)
    expect(() => decodeCbor(hex('6161ff'))).toThrow(/trailing/)
    expect(() => decodeCbor(hex('62ff'))).toThrow() // truncated + invalid utf-8
  })
})
