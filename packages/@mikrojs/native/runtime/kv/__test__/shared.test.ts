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

describe('read failures', () => {
  function recordingNative(getImpl: () => unknown) {
    const removed: string[] = []
    const written: Array<[string, unknown]> = []
    const native: NativeKvFns = {
      get: getImpl,
      set: (key, value) => {
        written.push([key, value])
        return {ok: true}
      },
      remove: (key) => {
        removed.push(key)
        return true
      },
      clear: () => {},
      info: () => ({entries: 0, used: 0, total: 0, free: 0}),
    }
    return {native, removed, written}
  }

  it('deletes and heals on TypeError (the corruption marker)', () => {
    const {native, removed, written} = recordingNative(() => {
      throw new TypeError('stored nvs value is not valid CBOR')
    })
    const createValue = makeCreateValue(native)
    const v = createValue('k', {onReadError: () => 'fallback'}) as {get: () => unknown}
    expect(v.get()).toBe('fallback')
    expect(removed).toEqual(['k'])
    expect(written).toEqual([['k', 'fallback']])
  })

  it('keeps the stored value intact on a transient read failure', () => {
    const seen: unknown[] = []
    const {native, removed, written} = recordingNative(() => {
      throw new Error('nvs open failed reading "k": ESP_ERR_NO_MEM')
    })
    const createValue = makeCreateValue(native)
    const v = createValue('k', {
      onReadError: (e: unknown) => {
        seen.push(e)
        return 'stand-in'
      },
    }) as {get: () => unknown}
    expect(v.get()).toBe('stand-in')
    expect(removed).toEqual([])
    expect(written).toEqual([])
    expect(seen).toHaveLength(1)
  })

  it('returns undefined on a transient failure with no onReadError', () => {
    const {native, removed} = recordingNative(() => {
      throw new Error('nvs read failed: ESP_FAIL')
    })
    const createValue = makeCreateValue(native)
    const v = createValue('k') as {get: () => unknown}
    expect(v.get()).toBeUndefined()
    expect(removed).toEqual([])
  })
})

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
