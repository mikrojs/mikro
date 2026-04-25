import {assertType, describe, expectTypeOf, it} from 'vitest'

import type {Result} from '../../result/types.js'
import {array, boolean, number, object, optional, string, tuple} from '../../schema/schema.js'
import type {SchemaError} from '../../schema/types.js'
import type {KVError, KVValue} from '../types.js'

// Use declare to avoid runtime import of native modules
declare const rtcStorage: import('../types.js').RtcStorage
declare const nvsStorage: import('../types.js').NvsStorage

describe('createValue type inference', () => {
  it('optional schema: get() returns T | undefined', () => {
    const val = rtcStorage.createValue('key', {schema: optional(number())})
    expectTypeOf(val.get()).toEqualTypeOf<number | undefined>()
  })

  it('optional schema with each primitive type', () => {
    const n = rtcStorage.createValue('n', {schema: optional(number())})
    expectTypeOf(n.get()).toEqualTypeOf<number | undefined>()

    const s = rtcStorage.createValue('s', {schema: optional(string())})
    expectTypeOf(s.get()).toEqualTypeOf<string | undefined>()

    const b = rtcStorage.createValue('b', {schema: optional(boolean())})
    expectTypeOf(b.get()).toEqualTypeOf<boolean | undefined>()
  })

  it('schema + initialValue + onReadError: get() returns T (no undefined)', () => {
    const val = rtcStorage.createValue('key', {
      schema: number(),
      initialValue: 0,
      onReadError: () => 0,
    })
    expectTypeOf(val.get()).toEqualTypeOf<number>()
  })

  it('object schema with initialValue', () => {
    const val = rtcStorage.createValue('key', {
      schema: object({name: string(), age: number()}),
      initialValue: {name: '', age: 0},
      onReadError: () => ({name: '', age: 0}),
    })
    expectTypeOf(val.get()).toEqualTypeOf<{name: string; age: number}>()
  })

  it('nested object schema with initialValue', () => {
    const val = rtcStorage.createValue('key', {
      schema: object({coords: object({lat: number(), lon: number()})}),
      initialValue: {coords: {lat: 0, lon: 0}},
      onReadError: () => ({coords: {lat: 0, lon: 0}}),
    })
    expectTypeOf(val.get()).toEqualTypeOf<{coords: {lat: number; lon: number}}>()
  })

  it('array schema with initialValue', () => {
    const val = rtcStorage.createValue('key', {
      schema: array(number()),
      initialValue: [],
      onReadError: () => [],
    })
    expectTypeOf(val.get()).toEqualTypeOf<number[]>()
  })

  it('optional array schema', () => {
    const val = rtcStorage.createValue('key', {schema: optional(array(string()))})
    expectTypeOf(val.get()).toEqualTypeOf<string[] | undefined>()
  })

  it('optional object schema', () => {
    const val = rtcStorage.createValue('key', {
      schema: optional(object({x: number(), y: number()})),
    })
    expectTypeOf(val.get()).toEqualTypeOf<{x: number; y: number} | undefined>()
  })

  it('tuple schema with initialValue', () => {
    const val = rtcStorage.createValue('key', {
      schema: tuple([string(), number(), boolean()]),
      initialValue: ['', 0, false] as [string, number, boolean],
      onReadError: () => ['', 0, false] as [string, number, boolean],
    })
    expectTypeOf(val.get()).toEqualTypeOf<[string, number, boolean]>()
  })

  it('optional tuple schema', () => {
    const val = rtcStorage.createValue('key', {
      schema: optional(tuple([string(), number()])),
    })
    expectTypeOf(val.get()).toEqualTypeOf<[string, number] | undefined>()
  })

  it('no options: get() returns unknown', () => {
    const val = rtcStorage.createValue('key')
    expectTypeOf(val.get()).toEqualTypeOf<unknown>()
  })
})

describe('nvsStorage', () => {
  it('optional schema returns KVValue<T | undefined>', () => {
    const val = nvsStorage.createValue('key', {schema: optional(string())})
    assertType<KVValue<string | undefined>>(val)
  })

  it('schema + initialValue returns non-optional', () => {
    const val = nvsStorage.createValue('key', {
      schema: number(),
      initialValue: 0,
      onReadError: () => 0,
    })
    expectTypeOf(val.get()).toEqualTypeOf<number>()
  })
})

describe('set()', () => {
  it('returns Result<T, KVError> with the written value', () => {
    const val = rtcStorage.createValue('key', {
      schema: number(),
      initialValue: 0,
      onReadError: () => 0,
    })
    expectTypeOf(val.set(42)).toEqualTypeOf<Result<number, KVError>>()
  })

  it('returns Result<T | undefined, KVError> with optional schema', () => {
    const val = rtcStorage.createValue('key', {schema: optional(number())})
    expectTypeOf(val.set(42)).toEqualTypeOf<Result<number | undefined, KVError>>()
  })

  it('accepts undefined to delete with optional schema', () => {
    const val = rtcStorage.createValue('key', {schema: optional(number())})
    val.set(undefined)
  })

  it('rejects undefined with non-optional schema + initialValue', () => {
    const val = rtcStorage.createValue('key', {
      schema: number(),
      initialValue: 0,
      onReadError: () => 0,
    })
    // @ts-expect-error -- cannot set undefined on non-optional value
    val.set(undefined)
  })

  it('rejects wrong type', () => {
    const val = rtcStorage.createValue('key', {
      schema: object({x: number()}),
      initialValue: {x: 0},
      onReadError: () => ({x: 0}),
    })
    // @ts-expect-error -- wrong shape
    val.set({y: 1})
    // @ts-expect-error -- wrong type
    val.set('hello')
    // valid
    val.set({x: 1})
  })

  it('rejects wrong type with optional schema', () => {
    const val = rtcStorage.createValue('key', {schema: optional(number())})
    // @ts-expect-error -- wrong type
    val.set('hello')
    // valid
    val.set(42)
    val.set(undefined)
  })
})

describe('update()', () => {
  it('updater receives T with initialValue', () => {
    const val = rtcStorage.createValue('key', {
      schema: number(),
      initialValue: 0,
      onReadError: () => 0,
    })
    val.update((n) => {
      assertType<number>(n)
      return n + 1
    })
  })

  it('updater receives T | undefined with optional schema', () => {
    const val = rtcStorage.createValue('key', {schema: optional(number())})
    val.update((n) => {
      assertType<number | undefined>(n)
      return (n ?? 0) + 1
    })
  })

  it('updater can return undefined to delete with optional schema', () => {
    const val = rtcStorage.createValue('key', {schema: optional(number())})
    val.update(() => undefined)
  })

  it('returns Result<T, KVError> with initialValue', () => {
    const val = rtcStorage.createValue('key', {
      schema: number(),
      initialValue: 0,
      onReadError: () => 0,
    })
    expectTypeOf(val.update((n) => n + 1)).toEqualTypeOf<Result<number, KVError>>()
  })

  it('returns Result<T | undefined, KVError> with optional schema', () => {
    const val = rtcStorage.createValue('key', {schema: optional(number())})
    expectTypeOf(val.update((n) => (n ?? 0) + 1)).toEqualTypeOf<
      Result<number | undefined, KVError>
    >()
  })
})

describe('delete()', () => {
  it('returns Result<void, KVError>', () => {
    const val = rtcStorage.createValue('key', {schema: optional(number())})
    expectTypeOf(val.delete()).toEqualTypeOf<Result<void, KVError>>()
  })
})

describe('onReadError', () => {
  it('without schema, error is KVError', () => {
    rtcStorage.createValue('key', {
      onReadError: (error) => {
        assertType<KVError>(error)
        return undefined
      },
    })
  })

  it('with schema, error is KVError | SchemaError', () => {
    rtcStorage.createValue('key', {
      schema: object({temp: number()}),
      initialValue: {temp: 0},
      onReadError: (error) => {
        assertType<KVError | SchemaError>(error)
        return {temp: 0}
      },
    })
  })

  it('can return undefined with optional schema', () => {
    rtcStorage.createValue('key', {
      schema: optional(number()),
      onReadError: () => undefined,
    })
  })

  it('can return a fallback value with optional schema', () => {
    const val = rtcStorage.createValue('key', {
      schema: optional(number()),
      onReadError: () => 42,
    })
    // Still optional since schema is optional(number())
    expectTypeOf(val.get()).toEqualTypeOf<number | undefined>()
  })
})
