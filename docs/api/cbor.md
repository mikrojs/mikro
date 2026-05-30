---
title: cbor
description: CBOR binary encoding and decoding
---

# cbor

```ts twoslash
import {encode, decode} from 'mikro/cbor'
```

Encode and decode [CBOR](https://cbor.io), a compact binary format similar to JSON but smaller and faster to parse. Used internally by the [kv](/api/kv) storage module.

## encode(value)

```ts
encode(value: unknown): Result<Uint8Array, CborError>
```

Encode a JavaScript value to CBOR bytes.

Supported types: `number`, `string`, `boolean`, `null`, `undefined`, `Uint8Array`, arrays, and plain objects with string keys. Functions, symbols, classes, and circular references are not supported.

```ts twoslash
// @noErrors
import {encode} from 'mikro/cbor'
// ---cut---
const bytes = encode({temp: 22.5, humidity: 65}).orPanic('encode failed')
// bytes is a Uint8Array
```

## decode(data)

```ts
decode(data: Uint8Array): Result<unknown, CborError>
```

Decode CBOR bytes back to a JavaScript value.

```ts twoslash
// @noErrors
import {encode, decode} from 'mikro/cbor'
// ---cut---
const bytes = encode(42).orPanic('encode')
const value = decode(bytes).orPanic('decode')
// value is 42
```

## CborError

| Variant        | When                                             |
| -------------- | ------------------------------------------------ |
| `EncodeFailed` | Value contains a type that can't be CBOR-encoded |
| `DecodeFailed` | Input bytes are not valid CBOR                   |
