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
  tuple,
  union,
  taggedUnion,
} from 'mikro/schema'
import type {Infer, Schema} from 'mikro/schema'
```

A lightweight runtime validation library for data crossing trust boundaries: [CBOR](/api/cbor)-decoded protocol messages, device config payloads, or any `unknown` value that needs a verified shape before use.

::: tip When do I need this?
Schemas are for data whose shape you can't verify at compile time. If you're just passing values between your own functions, TypeScript's type system already has you covered. Reach for `mikro/schema` at the boundaries where untyped data enters your program.
:::

## When to use

- **Typed storage:** [`nvsStorage`](/api/kv) and [`rtcStorage`](/api/kv) require a schema so values are validated when read back. Data in NVS can come from a previous firmware version; data in RTC RAM can be corrupted by a brownout.
- **External input:** Any data from outside the runtime (HTTP responses, serial messages, config payloads)
- **Shared schemas:** Define a shape once, use it for both validation and type inference via `Infer`

## When not to use

- **Internal data:** Values your code just created don't need validation. Use `satisfies Infer<typeof schema>` for compile-time type checking without runtime cost.
- **Hot loops:** Validation has overhead (typeof checks, property lookups per field). For high-frequency data, validate once at the boundary, then pass typed values through.
- **Complex transforms:** `parse()` validates shapes and nothing else: no transforms, no coercion. Defaults apply only through the separate [`applyDefaults`](#applydefaults). If you need to reshape data, do that separately.

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
} from 'mikro/schema'
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
import {object, literal, unknown} from 'mikro/schema'
// ---cut---
object({type: literal('data'), payload: unknown()})
```

### literal(value)

Matches a specific primitive value using strict equality (`===`).

```ts twoslash
import {literal} from 'mikro/schema'
// ---cut---
literal('error') // matches only the string 'error'
literal(42) // matches only the number 42
literal(true) // matches only true
```

### array(element)

Matches an array where every element matches the given schema.

```ts twoslash
import {array, string, object, number} from 'mikro/schema'
// ---cut---
array(string()) // string[]
array(object({x: number(), y: number()})) // {x: number, y: number}[]
```

### object(shape)

Matches a plain object with the specified fields. Extra keys are ignored (not rejected).

```ts twoslash
import {object, string, number} from 'mikro/schema'
// ---cut---
object({name: string(), age: number()})
```

Missing required fields cause a validation error. To make a field optional, wrap it with `optional()`.

### optional(schema)

Marks an object field as optional. The key may be absent from the object. If the key is present, its value must match the inner schema, except `undefined`, which reads the same as an absent key (JSON and CBOR cannot represent it, so the two cases are indistinguishable after a round trip anyway).

```ts twoslash
import {object, string, optional} from 'mikro/schema'
// ---cut---
object({
  name: string(),
  label: optional(string()), // key may be absent, but if present must be a string
})
```

### tuple(elements)

Matches an array of exactly the given length, each position validated against its own schema.

```ts twoslash
import {tuple, string, number} from 'mikro/schema'
// ---cut---
tuple([number(), number()]) // [number, number]
tuple([string(), number()]) // [string, number]
```

A wrong length reports "expected N elements"; a wrong element reports at its index.

### union(members)

Matches if the value matches any member schema. Tries each member in order; returns ok on the first match.

```ts twoslash
import {union, string, number} from 'mikro/schema'
// ---cut---
union([string(), number()]) // string | number
```

When no member matches, the error reports "value did not match any union member". A union with no members matches nothing at all, so the config-schema check the CLI and the registry run rejects an empty one outright.

### taggedUnion(key, branches)

Matches an object by looking up a discriminator field and validating against the corresponding branch. O(1) dispatch instead of trying every branch.

```ts twoslash
import {taggedUnion, object, string, number} from 'mikro/schema'
// ---cut---
const Message = taggedUnion('type', {
  error: object({message: string()}),
  success: object({value: number()}),
})
// Inferred: {type: 'error', message: string} | {type: 'success', value: number}
```

The discriminator field (`type` above) is injected into each branch's inferred type automatically. You don't need to include it in the branch schemas.

## Annotations

Constructors take an optional trailing options object for annotations: properties stored on the schema node that don't change what validates. Structural arguments stay positional; annotations trail.

```ts twoslash
import {array, boolean, literal, number, object, string, union} from 'mikro/schema'
// ---cut---
object({
  mqttUrl: string(),
  interval: number({default: 60}),
  logLevel: union([literal('debug'), literal('info')], {default: 'info'}),
  tags: array(string(), {default: []}),
  enabled: boolean({default: false}),
})
```

### default

Available on every node except `object()` (objects are structure; their fields carry the defaults), `unknown()` and `optional()`. The default must itself match the node; a mismatch throws a `TypeError` where the schema is written. `optional()` and `default` are mutually exclusive, since both define what absence means.

Defaults come in two tiers, matching how [`applyDefaults`](#applydefaults) builds a value:

- **Plain objects compose.** An object materializes field by field, so its fields carry the defaults. Passing a default to `object()` itself throws a `TypeError`.
- **Arrays, tuples and unions (tagged or plain) are wholesale.** A present value replaces the node whole, so a default on one of them is a complete value or nothing. A union has nothing to compose from anyway: no rule can pick a member.

A default written anywhere below a wholesale unit would never fill anything, so it throws a `TypeError` where it is written:

```ts twoslash
import {number, object, taggedUnion} from 'mikro/schema'
// ---cut---
// throws: a default under a taggedUnion never applies; give the union itself a
// whole-value default instead (found at .a.x)
taggedUnion('kind', {a: object({x: number({default: 1})})})

// the supported form: one whole value on the unit
taggedUnion('kind', {a: object({x: number()})}, {default: {kind: 'a', x: 1}})
```

The rule holds through nested objects and `optional()`, and it rejects a nested unit's own whole-value default too, since that one never applies either.

`parse()` ignores defaults entirely: it validates, nothing else. Defaults take effect through [`applyDefaults`](#applydefaults), which builds the effective value for a partial input. This is what device config uses: the [OTA registry](/registry-spec) validates the effective config on every serve and sends the deviation overlay, which the device spreads over its own manifest defaults.

Annotations serialize with the schema (`JSON.stringify` of a schema node is its wire form), and consumers ignore annotation properties they don't recognize.

## Validation

### parse(schema, value) {#parse}

Validates `value` against `schema`. Returns a `Result`: `ok` with the typed value, or `err` with a `SchemaError` describing what went wrong and where.

```ts twoslash
import {parse, object, string, number, optional} from 'mikro/schema'
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

### applyDefaults(schema, value) {#applydefaults}

Builds the effective value for a partial input: schema defaults with `value` layered over them. Objects materialize, recursing per field and dropping keys the schema doesn't know (a present value that is not an object passes through untouched, so `parse()` still reports it). Every other node is replaced wholesale by a present value, which is why only a whole-value default on a unit applies (a default written below one is [rejected where it is written](#default)). An absent array reads as its default, or `[]` without one.

```ts twoslash
import {applyDefaults, number, object, string} from 'mikro/schema'
// ---cut---
const schema = object({host: string({default: 'mqtt.local'}), port: number({default: 1883})})

applyDefaults(schema, {port: 9000}) // {host: 'mqtt.local', port: 9000}
applyDefaults(schema, undefined) // {host: 'mqtt.local', port: 1883}
```

The result is unvalidated. A required field with no default and no supplied value stays missing, so run the result through `parse()` to get a typed value:

```ts twoslash
import {applyDefaults, number, object, parse, string} from 'mikro/schema'
const schema = object({host: string({default: 'mqtt.local'}), port: number({default: 1883})})
// ---cut---
const config = parse(schema, applyDefaults(schema, {port: 9000}))
```

## Error reporting

Errors include the path to the offending value using dot-bracket notation:

```ts twoslash
import {parse, object, array, string, number} from 'mikro/schema'
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
import {object, string, number, optional} from 'mikro/schema'
import type {Infer} from 'mikro/schema'
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

### InferRead: the read type

`Infer<S>` is the write type: everything an operator has to supply for a document to validate. `InferRead<S>` is the read type, what a document rebuilt from defaults can hand back, so a field defaults cannot fill is optional there. This is the shape device config is read as:

```ts twoslash
import {number, object, string} from 'mikro/schema'
import type {Infer, InferRead} from 'mikro/schema'
// ---cut---
const Config = object({
  interval: number({default: 60}),
  apiKey: string(),
})

type Write = Infer<typeof Config>
//   ^?
type Read = InferRead<typeof Config>
//   ^?
```

A field stays required in the read type when the materialized defaults always contain it: any node carrying a default, or a plain object whose fields all fill (or are `optional()`), which `InferRead` recurses into. The rest read as optional: a defaultless leaf, a defaultless array, a wholesale unit with no whole-value default, and a plain object with any unfillable field, which is omitted whole. `optional()` fields are optional in both types.

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
  | TupleSchema
  | UnionSchema
  | TaggedUnionSchema
```

### SchemaError

```ts
type SchemaError = {name: 'ValidationFailed'; message: string; path: string}
```

Created via `SchemaError.ValidationFailed(message, path)`.
