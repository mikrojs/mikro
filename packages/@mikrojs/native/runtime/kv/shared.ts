import {err, ok} from 'mikrojs/result'
// Typed loosely to avoid deep type instantiation from Infer<S> in parse's generics.
// Type safety is provided by the storage interface overloads in types.ts.
import {parse as _parse} from 'mikrojs/schema'

import type {NativeError} from '../result/types.js'

type ParseResult = {ok: true; value: unknown} | {ok: false; error: {message: string; path: string}}
const parse = _parse as unknown as (schema: unknown, value: unknown) => ParseResult

export const KVError = {
  StorageFull: (message: string) => ({name: 'StorageFull', message}) as const,
  EncodeFailed: (message: string) => ({name: 'EncodeFailed', message}) as const,
  WriteFailed: (message: string) => ({name: 'WriteFailed', message}) as const,
  ValidationFailed: (message: string, path: string) =>
    ({name: 'ValidationFailed', message, path}) as const,
  Unknown: (code: number, message: string) => ({name: 'Unknown', code, message}) as const,
}

/* Error codes from errors.h (MIK_ERR_BASE + 0xD0..0xD4) */
const KV_INVALID_KEY = 0x80d0
const KV_ENCODE = 0x80d1
const KV_TOO_LARGE = 0x80d2
const KV_STORAGE_FULL = 0x80d3
const KV_WRITE = 0x80d4

type NativeResult = {ok: true} | {ok: false; error: NativeError}

export type NativeKvFns = {
  get: (key: string) => unknown
  set: (key: string, value: unknown) => NativeResult
  remove: (key: string) => boolean
  clear: () => void
  info: () => unknown
}

function mapKvError(e: NativeError) {
  switch (e.code) {
    case KV_STORAGE_FULL:
    case KV_TOO_LARGE:
      return KVError.StorageFull(e.message)
    case KV_ENCODE:
    case KV_INVALID_KEY:
      return KVError.EncodeFailed(e.message)
    case KV_WRITE:
      return KVError.WriteFailed(e.message)
    default:
      return KVError.Unknown(e.code, e.message)
  }
}

export function makeCreateValue(native: NativeKvFns) {
  return function createValue(key: string, options?: any): any {
    const schema = options?.schema
    const initialValue = options?.initialValue
    const hasInitialValue = options !== undefined && 'initialValue' in options
    const onReadError = options?.onReadError ?? (() => undefined)

    function doGet(): unknown {
      try {
        const v = native.get(key)
        if (v === undefined) return hasInitialValue ? initialValue : undefined
        if (schema) {
          const result = parse(schema, v)
          if (!result.ok) {
            // Schema mismatch: data decoded fine, don't delete it
            return onReadError(result.error)
          }
          return result.value
        }
        return v
      } catch (e) {
        // Decode failure: corrupt data, delete it
        native.remove(key)
        const fallback = onReadError(e)
        if (fallback !== undefined) native.set(key, fallback)
        return fallback
      }
    }

    function doSet(value: unknown) {
      if (value === undefined) {
        native.remove(key)
        return ok(undefined)
      }
      if (schema) {
        const result = parse(schema, value)
        if (!result.ok) {
          return err(KVError.ValidationFailed(result.error.message, result.error.path))
        }
      }
      const result = native.set(key, value)
      if (!result.ok) return err(mapKvError(result.error))
      return ok(value)
    }

    return {
      get: doGet,
      set: doSet,
      update(updater: (value: any) => any) {
        return doSet(updater(doGet()))
      },
      delete() {
        const removed = native.remove(key)
        return removed ? ok() : err(KVError.WriteFailed(`failed to delete key "${key}"`))
      },
    }
  }
}
