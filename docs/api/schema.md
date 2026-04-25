---
title: schema
description: Runtime schema validation with TypeScript type inference
---

# schema

```ts twoslash
import {
  parse,
  string,
  number,
  boolean,
  unknown,
  literal,
  array,
  object,
  optional,
  union,
  taggedUnion,
} from 'mikrojs/schema'
import type {Infer, Schema} from 'mikrojs/schema'
```

A lightweight runtime validation library for data crossing trust boundaries: [CBOR](/api/cbor)-decoded protocol messages, device config payloads, or any `unknown` value that needs a verified shape before use.

::: tip When do I need this?
Schemas are for data whose shape you can't verify at compile time. If you're just passing values between your own functions, TypeScript's type system already has you covered. Reach for `mikrojs/schema` at the boundaries where untyped data enters your program.
:::

## When to use

- **Typed storage:** [`nvsStorage`](/api/kv) and [`rtcStorage`](/api/kv) require a schema so values are validated when read back. Data in NVS can come from a previous firmware version; data in RTC RAM can be corrupted by a brownout.
- **External input:** Any data from outside the runtime (HTTP responses, serial messages, config payloads)
- **Shared schemas:** Define a shape once, use it for both validation and type inference via `Infer`

## When not to use

- **Internal data:** Values your code just created don't need validation. Use `satisfies Infer<typeof schema>` for compile-time type checking without runtime cost.
- **Hot loops:** Validation has overhead (typeof checks, property lookups per field). For high-frequency data, validate once at the boundary, then pass typed values through.
- **Complex transforms:** This library validates shapes. It does not transform, coerce, or default values. If you need to reshape data, do that separately.

## Defining schemas

Schemas are plain tagged objects. They carry no methods and cost nothing until passed to `parse()`.

```ts twoslash
import {
  string,
  number,
  boolean,
  literal,
  array,
  object,
  optional,
  union,
  taggedUnion,
} from 'mikrojs/schema'
// ---cut---
const SensorReading = object({
  temperature: number(),
  humidity: number(),
  label: optional(string()),
})
```

### Primitives

```ts
string() // matches typeof === 'string'
number() // matches typeof === 'number'
boolean() // matches typeof === 'boolean'
```

### unknown()

Accepts any value without validation. Infers as `unknown`. Useful for partial validation where some fields are left unchecked.

```ts twoslash
import {object, literal, unknown} from 'mikrojs/schema'
// ---cut---
object({type: literal('data'), payload: unknown()})
```

### literal(value)

Matches a specific primitive value using strict equality (`===`).

```ts twoslash
import {literal} from 'mikrojs/schema'
// ---cut---
literal('error') // matches only the string 'error'
literal(42) // matches only the number 42
literal(true) // matches only true
```

### array(element)

Matches an array where every element matches the given schema.

```ts twoslash
import {array, string, object, number} from 'mikrojs/schema'
// ---cut---
array(string()) // string[]
array(object({x: number(), y: number()})) // {x: number, y: number}[]
```

### object(shape)

Matches a plain object with the specified fields. Extra keys are ignored (not rejected).

```ts twoslash
import {object, string, number} from 'mikrojs/schema'
// ---cut---
object({name: string(), age: number()})
```

Missing required fields cause a validation error. To make a field optional, wrap it with `optional()`.

### optional(schema)

Marks an object field as optional. The key may be absent from the object. If the key is present, its value must match the inner schema. A key present with value `undefined` is rejected (consistent with JSON semantics where `undefined` values are omitted during serialization).

```ts twoslash
import {object, string, optional} from 'mikrojs/schema'
// ---cut---
object({
  name: string(),
  label: optional(string()), // key may be absent, but if present must be a string
})
```

### union(members)

Matches if the value matches any member schema. Tries each member in order; returns ok on the first match.

```ts twoslash
import {union, string, number} from 'mikrojs/schema'
// ---cut---
union([string(), number()]) // string | number
```

When no member matches, the error reports "value did not match any union member".

### taggedUnion(key, branches)

Matches an object by looking up a discriminator field and validating against the corresponding branch. O(1) dispatch instead of trying every branch.

```ts twoslash
import {taggedUnion, object, string, number} from 'mikrojs/schema'
// ---cut---
const Message = taggedUnion('type', {
  error: object({message: string()}),
  success: object({value: number()}),
})
// Inferred: {type: 'error', message: string} | {type: 'success', value: number}
```

The discriminator field (`type` above) is injected into each branch's inferred type automatically. You don't need to include it in the branch schemas.

## Validation

### parse(schema, value)

Validates `value` against `schema`. Returns a `Result`: `ok` with the typed value, or `err` with a `SchemaError` describing what went wrong and where.

```ts twoslash
import {parse, object, string, number, optional} from 'mikrojs/schema'
// ---cut---
const Device = object({
  chip: string(),
  id: optional(string()),
})

const result = parse(Device, {chip: 'esp32c6'})
if (result.ok) {
  result.value.chip // string
  result.value.id // string | undefined
}
```

Validation is fail-fast: it stops at the first error.

## Error reporting

Errors include the path to the offending value using dot-bracket notation:

```ts twoslash
import {parse, object, array, string, number} from 'mikrojs/schema'
// ---cut---
const schema = object({
  items: array(object({name: string()})),
})

const result = parse(schema, {items: [{name: 'ok'}, {name: 42}]})
if (!result.ok) {
  result.error.message // 'expected string, got number'
  result.error.path // '.items[1].name'
}
```

## Type inference

Use `Infer<S>` to extract the TypeScript type from a schema without calling `parse`:

```ts twoslash
import {object, string, number, optional} from 'mikrojs/schema'
import type {Infer} from 'mikrojs/schema'
// ---cut---
const Device = object({
  chip: string(),
  version: number(),
  label: optional(string()),
})

type Device = Infer<typeof Device>
// {chip: string, version: number, label?: string | undefined}
```

This is purely a compile-time operation. No runtime cost.

## Types

### Schema

The union of all schema node types. Use this as a constraint when writing functions that accept any schema:

```ts
type Schema =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | UnknownSchema
  | LiteralSchema
  | ArraySchema
  | ObjectSchema
  | OptionalSchema
  | UnionSchema
  | TaggedUnionSchema
```

### SchemaError

```ts
type SchemaError = {name: 'ValidationFailed'; message: string; path: string}
```

Created via `SchemaError.ValidationFailed(message, path)`.
