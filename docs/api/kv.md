---
title: kv
description: Key-value storage with RTC and NVS backing stores
---

# kv

Key-value storage with two backing stores: RTC memory (volatile, fast) and NVS flash (persistent, wear-limited). Each backend lives at its own subpath so apps that only need one don't pay for the other's native code.

```ts twoslash
import {rtcStorage} from 'mikrojs/kv/rtc'
import {nvsStorage} from 'mikrojs/kv/nvs'
```

## Choosing a store

| Store        | Import path      | Survives deep sleep | Survives power off | Capacity | Write wear              |
| ------------ | ---------------- | ------------------- | ------------------ | -------- | ----------------------- |
| `rtcStorage` | `mikrojs/kv/rtc` | Yes                 | No                 | ~2 KB    | None (RAM)              |
| `nvsStorage` | `mikrojs/kv/nvs` | Yes                 | Yes                | ~24 KB   | ~100k cycles per sector |

`rtcStorage` is plain RAM with no write-wear concerns. `nvsStorage` is flash-backed and survives power cycles, but has limited write endurance. Avoid high-frequency writes on flash; use `rtcStorage` for those and only flush to NVS when needed.

NVS keys are limited to 15 characters.

## rtcStorage

Store small values in RTC memory that persist across deep sleep cycles. Lost on hard reset or power loss. Values are [CBOR](/api/cbor)-encoded.

## nvsStorage

Store values in NVS flash that persist across power cycles. Keys limited to 15 characters. Values are [CBOR](/api/cbor)-encoded.

::: warning Storage is not encrypted
NVS values are stored as plaintext in flash. Anyone with physical access to the device can dump the flash and read them.
:::

## Shared API

Both stores share the same `createValue` API.

### createValue(key, options?)

```ts
createValue<S extends StorableSchema>(key: string, options?: KVOptions<S>): KVValue<Infer<S>>
```

Create a handle to a named value. Without a schema, values are untyped (`unknown`). Pass a schema for type-safe storage.

Values are [CBOR](/api/cbor)-encoded. Supported schema types: `s.number()`, `s.string()`, `s.boolean()`, `s.optional()`, `s.array()`, and `s.object()`. See [schema](/api/schema) for details.

```ts twoslash
import {nvsStorage} from 'mikrojs/kv/nvs'
import {rtcStorage} from 'mikrojs/kv/rtc'
import * as s from 'mikrojs/schema'
// ---cut---
const counter = rtcStorage.createValue('counter', {schema: s.optional(s.number())})
const brightness = nvsStorage.createValue('brightness', {schema: s.optional(s.number())})
const state = rtcStorage.createValue('state', {
  schema: s.optional(s.object({temp: s.number(), humidity: s.number()})),
})
```

With an error handler for corrupt data:

```ts twoslash
import {nvsStorage} from 'mikrojs/kv/nvs'
import * as s from 'mikrojs/schema'
const SensorReading = s.object({temp: s.number(), humidity: s.number()})
// ---cut---
const fallback = {temp: 0, humidity: 0}
const state = nvsStorage.createValue('state', {
  schema: SensorReading,
  initialValue: fallback,
  onReadError: (error) => {
    console.warn(`corrupt: ${error.message}`)
    return fallback
  },
})
```

### clear()

Erase all data in the store.

### info()

Returns storage usage information.

- `rtcStorage.info()` returns `{used, total, entries}` (bytes)
- `nvsStorage.info()` returns `{entries, used, total, free}` (entry slots; partition-wide)

## KVValue methods

### value.get()

```ts
get(): T | undefined
```

Read the value. Returns `undefined` if the key doesn't exist. On corrupt or invalid data, calls `onReadError` (default: deletes the key, returns `undefined`).

```ts twoslash
import {rtcStorage} from 'mikrojs/kv/rtc'
import * as s from 'mikrojs/schema'
const counter = rtcStorage.createValue('counter', {schema: s.optional(s.number())})
// ---cut---
const value = counter.get() ?? 0
```

### value.set(value)

```ts
set(value: T | undefined): Result<T, KVError>
```

Write a value. Returns the written value on success. Passing `undefined` deletes the key (same as `delete()`).

```ts twoslash
import {rtcStorage} from 'mikrojs/kv/rtc'
import * as s from 'mikrojs/schema'
const counter = rtcStorage.createValue('counter', {schema: s.optional(s.number())})
// ---cut---
counter.set(42).orPanic('store failed')
counter.set(undefined) // deletes the key
```

### value.update(updater)

```ts
update(updater: (value: T | undefined) => T | undefined): Result<T, KVError>
```

Read, transform, and write. Returns the updated value on success. Receives `undefined` if key is missing. Return `undefined` to delete.

```ts twoslash
import {rtcStorage} from 'mikrojs/kv/rtc'
import * as s from 'mikrojs/schema'
const counter = rtcStorage.createValue('counter', {schema: s.optional(s.number())})
// ---cut---
counter.update((n) => (n ?? 0) + 1)
```

### value.delete()

Remove the key from storage.

## onReadError

Called when stored data can't be read ([CBOR](/api/cbor) decode failure, [schema](/api/schema) mismatch). Receives a `KVError` (or `KVError` | [`SchemaError`](/api/schema#parse) when a schema is provided).

On decode failure (corrupt data), the key is deleted before calling the handler. Return a fallback to write back, or `undefined` to leave it empty.

On schema mismatch, the stored data is left intact (it decoded fine, just doesn't match the current schema). The handler will be called again on every subsequent read until the data is overwritten or deleted.

Default: `() => undefined`.

## KVError

Errors returned by `set()` and `update()`, or passed to `onReadError`:

| Variant            | When                                        |
| ------------------ | ------------------------------------------- |
| `StorageFull`      | RTC memory or NVS partition is full         |
| `EncodeFailed`     | Value is not [CBOR](/api/cbor)-encodable    |
| `WriteFailed`      | NVS open/commit failed (hardware error)     |
| `ValidationFailed` | Schema validation failed (has `path` field) |
