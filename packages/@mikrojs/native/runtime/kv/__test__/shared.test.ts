import {describe, expect, it} from 'vitest'

import {makeCreateValue, type NativeKvFns} from '../shared.js'

function fakeNative(setResult: ReturnType<NativeKvFns['set']>): NativeKvFns {
  return {
    get: () => undefined,
    set: () => setResult,
    remove: () => true,
    clear: () => {},
    info: () => ({entries: 0, used: 0, total: 0, free: 0}),
  }
}

describe('mapKvError', () => {
  // mapKvError is internal; exercise it via the set() path on a createValue.
  it('maps unknown native error codes to KVError.Unknown', () => {
    const native = fakeNative({
      ok: false,
      error: {code: 0x80ff, message: 'something weird'},
    })
    const createValue = makeCreateValue(native)
    const v = createValue('k') as {set: (x: unknown) => {ok: false; error: unknown}}
    const result = v.set(42)
    expect(result.ok).toBe(false)
    expect(result.error).toEqual({
      name: 'Unknown',
      code: 0x80ff,
      message: 'something weird',
    })
  })

  it('maps known native error codes to their named variants', () => {
    const native = fakeNative({
      ok: false,
      error: {code: 0x80d3, message: 'full'},
    })
    const createValue = makeCreateValue(native)
    const v = createValue('k') as {set: (x: unknown) => {ok: false; error: {name: string}}}
    const result = v.set(42)
    expect(result.ok).toBe(false)
    expect(result.error.name).toBe('StorageFull')
  })
})
