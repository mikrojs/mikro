import {decode, encode} from 'mikrojs/cbor'
import {assert, describe, test} from 'mikrojs/test'

function roundtrip(label: string, value: unknown) {
  test(`roundtrip: ${label}`, () => {
    const encodedResult = encode(value)
    assert.ok(encodedResult)
    const encoded = encodedResult.value
    assert.instance(encoded, Uint8Array)
    assert.truthy(encoded.length > 0, 'encoded should not be empty')
    const decodedResult = decode(encoded)
    assert.ok(decodedResult)
    assert.deepEqual(decodedResult.value, value)
  })
}

describe('cbor', () => {
  roundtrip('integer', 42)
  roundtrip('zero', 0)
  roundtrip('negative integer', -7)
  roundtrip('string', 'hello')
  roundtrip('empty string', '')
  roundtrip('boolean true', true)
  roundtrip('boolean false', false)
  roundtrip('null', null)
  roundtrip('array', [1, 2, 3])
  roundtrip('empty array', [])
  roundtrip('object', {a: 1, b: 'two'})
  roundtrip('empty object', {})
  roundtrip('nested', {a: {b: {c: [1, 2]}}})

  // These specifically caught the 32-bit NaN-boxing bug (JS_VALUE_GET_TAG vs NORM_TAG)
  roundtrip('float', 3.14)
  roundtrip('large integer', 1743976000000)
  roundtrip('negative float', -273.15)

  test('encode Date.now() value', () => {
    const value = {ts: Date.now()}
    const encodedResult = encode(value)
    assert.ok(encodedResult)
    const decodedResult = decode(encodedResult.value)
    assert.ok(decodedResult)
    assert.equal((decodedResult.value as {ts: number}).ts, value.ts)
  })
})
