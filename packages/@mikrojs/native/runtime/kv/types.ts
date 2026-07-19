import type {Result} from '../result/types.js'
import type {
  ArraySchema,
  BooleanSchema,
  Infer,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  SchemaError,
  StringSchema,
  TupleSchema,
  UnknownSchema,
} from '../schema/types.js'

export interface RtcMemoryInfo {
  used: number
  total: number
  entries: number
}

export interface NvsStorageInfo {
  /** Number of entries in the kv namespace. */
  entries: number
  /** Used entries across all NVS namespaces. */
  used: number
  /** Total entries in the NVS partition. */
  total: number
  /** Free entries in the NVS partition. */
  free: number
}

/** Values that can be stored (CBOR-serializable). */
export type Storable =
  | number
  | string
  | boolean
  | undefined
  | Uint8Array
  | Storable[]
  | {[key: string]: Storable}

/** Values that can be stored (CBOR-serializable). */
export type StorableSchema =
  | NumberSchema
  | StringSchema
  | UnknownSchema
  | BooleanSchema
  | OptionalSchema
  | ArraySchema<StorableSchema>
  | TupleSchema<StorableSchema[]>
  | ObjectSchema<{[key: string]: StorableSchema}>

export type KVError =
  | {name: 'StorageFull'; message: string}
  | {name: 'EncodeFailed'; message: string}
  | {name: 'WriteFailed'; message: string}
  | {name: 'ValidationFailed'; message: string; path: string}
  | {name: 'Unknown'; code: number; message: string}

export type KVOptions<S> =
  | {
      schema: S
      initialValue: Infer<S>
      /** Called when reading stored data fails (decode error, schema mismatch).
       *  On decode failure, corrupt data is deleted. On schema mismatch, stored data is kept.
       *  Return a fallback value, or undefined. Default: `() => undefined`. */
      onReadError: (error: KVError | SchemaError) => Infer<S>
    }
  | {
      schema: OptionalSchema
      initialValue?: Infer<S>
      /** Called when reading stored data fails (decode error, schema mismatch).
       *  On decode failure, corrupt data is deleted. On schema mismatch, stored data is kept.
       *  Return a fallback value, or undefined. Default: `() => undefined`. */
      onReadError?: (error: KVError | SchemaError) => Infer<S>
    }
  | {
      schema?: never
      initialValue: unknown
      /** Called when reading stored data fails (decode error, schema mismatch).
       *  On decode failure, corrupt data is deleted. On schema mismatch, stored data is kept.
       *  Return a fallback value, or undefined. Default: `() => undefined`. */
      onReadError: (error: KVError) => unknown
    }
  | {
      schema?: never
      initialValue?: unknown
      /** Called when reading stored data fails (decode error, schema mismatch).
       *  On decode failure, corrupt data is deleted. On schema mismatch, stored data is kept.
       *  Return a fallback value, or undefined. Default: `() => undefined`. */
      onReadError?: (error: KVError) => unknown
    }

export interface KVValue<T> {
  /** Read the value. Returns undefined if the key doesn't exist. */
  get(): T
  /** Write a value, or delete the key if undefined. Returns the written value on success. */
  set(value: T): Result<T, KVError>
  /** Read, transform, and write. Receives undefined if key is missing. Return undefined to delete. */
  update(updater: (value: T) => T): Result<T, KVError>
  /** Remove the key. Returns ok on success, err if the storage operation fails. */
  delete(): Result<void, KVError>
}

export type InferOpts<
  Schema extends StorableSchema,
  Options extends KVOptions<Schema>,
> = Options extends {
  schema?: never
  initialValue: infer I
  onReadError: (error: KVError) => infer V
}
  ? I | V
  : Options extends {schema: infer S}
    ? Infer<S>
    : unknown

export interface RtcStorage {
  createValue<Schema extends StorableSchema, Opts extends KVOptions<Schema>>(
    key: string,
    options?: Opts,
  ): KVValue<InferOpts<Schema, Opts>>

  /** Clear all RTC data. */
  clear(): void
  /** Get info about RTC memory usage. */
  info(): RtcMemoryInfo
}

/**
 * NVS-backed key-value storage. Survives power cycles.
 * Keys are limited to 15 characters (NVS constraint).
 * Flash-backed: avoid high-frequency writes.
 */
export interface NvsStorage {
  createValue<Schema extends StorableSchema, Opts extends KVOptions<Schema>>(
    key: string,
    options?: Opts,
  ): KVValue<InferOpts<Schema, Opts>>

  /** Erase all app key-value data. With `{full: true}`, also erase the runtime's
   *  system store. The system store is never touched otherwise. */
  clear(options?: {full?: boolean}): Result<void, KVError>
  /** Get info about NVS key-value usage. */
  info(): NvsStorageInfo
}

/** RTC memory store. Survives deep sleep, lost on power off. */
export declare const rtcStorage: RtcStorage

/** NVS flash store. Survives power cycles. */
export declare const nvsStorage: NvsStorage
