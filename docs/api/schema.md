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

Constructors take an optional trailing options object for annotations: extra properties stored on the schema node. Structural arguments stay positional; annotations trail.

Annotations come in two kinds, and the difference matters to anyone reading a published schema:

- **Display annotations** (`title`, `description`, `mask`) describe how a value should be presented. They never change what validates, and a consumer that does not render a form may ignore any it does not recognise.
- **Constraints** (`min`, `max`, `integer`, `minLength`, `maxLength`, `minItems`, `maxItems`, `format`, `unit`) change what validates. A consumer may **not** ignore one it does not recognise, because ignoring a constraint means accepting a value the schema's author ruled out.

::: warning Constraints are checked on the host, not on the device
Constraints are checked where config is written: by a registry when an operator saves a value, and by `mikro ota pack`. [`parse()`](#parse) checks structure only, so `parse(number({max: 30}), 200)` returns `ok` on a device.

A config schema never reaches a device, which is why the device runtime does not carry the checks. If your app needs a bound at runtime, check it in your own code.
:::

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

### title and description

A label and an explanatory sentence, on every node kind. A registry renders an operator-facing config form from your published schema, and without them the field names are the labels.

```ts twoslash
import {number, object, string} from 'mikro/schema'
// ---cut---
object({
  broker: object(
    {
      url: string({title: 'Broker URL', description: 'Where the device publishes readings.'}),
    },
    {title: 'MQTT'},
  ),
  interval: number({title: 'Poll interval', default: 60}),
})
```

A node's `title` labels the control it renders, and a child's labels the child. So a `union` of literals gets its own title for the field and one per `literal` for each choice, and a `taggedUnion`'s title labels the selector while each branch object's title labels that branch. Titles are capped at 80 characters and descriptions at 500.

They go on the node they describe, never on the `optional()` wrapper: absence is what `optional()` expresses, identity is what the node it wraps expresses.

### mask

On `string()` and `number()`: **do not display this value in cleartext**. A form renders a password input, and anything else that prints a config document redacts.

That is all it does. It is not a security feature. Config values are plaintext end to end, stored in the registry, carried in the clear inside TLS on the check-in response, and held in device NVS as plaintext. Credentials belong in [env vars](/api/env), which are set over the cable and never travel through a registry. A masked field cannot carry a default, since a default credential is the same placeholder on every device.

### Constraints

`number()` takes `min`, `max` and `integer`; `string()` takes `minLength` and `maxLength`; `array()` takes `minItems` and `maxItems`.

```ts twoslash
import {array, number, object, string} from 'mikro/schema'
// ---cut---
object({
  pin: number({title: 'LED pin', default: 15, min: 0, max: 30, integer: true}),
  ssid: string({minLength: 1, maxLength: 32}),
  topics: array(string(), {maxItems: 8}),
})
```

These are what stop an operator saving a value the device cannot survive. A registry checks every write against the published schema, and that is the only gate before a value reaches a device, so a bound that is not in the schema is not a bound at all.

They catch typos and magnitude errors, not board-specific validity. A usable GPIO set differs per chip and one schema is authored for every chip an app targets, so `min` and `max` on a pin are an approximation and your app should still check its pins at runtime.

A default must satisfy its own constraints. Unlike a default of the wrong _type_, which throws a `TypeError` where the schema is written, a default that breaks its own bound is reported when the config is packed, since that is where constraints are checked.

### format

A named shape for a string, from a closed set: `url`, `hostname`, `ipv4`, `mac`, `email`.

```ts twoslash
import {object, string} from 'mikro/schema'
// ---cut---
object({
  broker: string({format: 'url'}),
  fallback: string({format: 'ipv4', default: '192.168.1.1'}),
})
```

There is deliberately no `pattern`. A registry evaluates your published schema against operator input, so a caller-supplied regular expression would hand anyone who can publish a denial-of-service vector against the registry. These expressions are fixed and linear.

`url` accepts any scheme with an authority, not only http and https, because `mqtt://` and `ws://` are ordinary device-config values. Restricting the scheme is not expressible today.

### unit

The unit of a number, from a closed set, so a form can show it, pick a sensible control and offer a readable hint next to an awkward magnitude.

```ts twoslash
import {number, object} from 'mikro/schema'
// ---cut---
object({
  interval: number({title: 'Check-in interval', unit: 'ms', default: 60_000}),
  clock: number({unit: 'kHz', default: 400}),
  setpoint: number({unit: 'Cel', default: 21}),
})
```

The set is the [IANA SenML](https://www.iana.org/assignments/senml/senml.xhtml) Units and Secondary Units registries, minus the entries SenML marks as not recommended for new producers, plus the microcontroller units its registry lacks (`us`, `kHz`, `mW`, `uA`, `mAh`, `MiB`, `kohm`, `Bd` and others). Keys are ASCII; a renderer maps them to a display symbol, so `Cel` shows as `°C`, `us` as `µs` and `Ohm` as `Ω`.

A ratio from 0 to 1 is `/`, which is the registry's name for a dimensionless value. A form renders it with no suffix, since `0.8 /` would mean nothing to an operator. `count` behaves the same way. Use `/` for a duty cycle or a gain, and `/100` for a field an operator thinks of as 0 to 100.

Two symbols do not mean what you would expect:

- SenML's `%` is **not** a percentage. It is a synonym for the ratio `/` (0 to 1), and the RFC says so explicitly, so it is excluded here. A 0-100 field uses `/100`, which renders as `%`.
- There is no `d` for day. A bare `d` is the SI deci- prefix, which the SenML naming rules forbid as a standalone symbol. Use `h`.

**The unit describes the stored value and never converts it.** Declare the unit your app actually reads. If an operator should think in minutes, declare the field in minutes and multiply once where you read it, rather than storing seconds and displaying minutes.

Changing a field's unit in a later release is a breaking change even though nothing fails validation: `30` means one thing under `s` and another under `ms`, so every value already stored is silently reinterpreted.

### enumOf(entries)

A closed list of values with a label for each, which is what a form renders as a select or a radio group.

```ts twoslash
import {enumOf, object} from 'mikro/schema'
// ---cut---
const schema = object({
  logLevel: enumOf(
    [
      {value: 'debug', title: 'Debug', description: 'Verbose; not for production.'},
      {value: 'info', title: 'Info'},
      {value: 'warn', title: 'Warning'},
    ],
    {default: 'info'},
  ),
})
```

It is sugar, not a node kind: it builds a `union` of annotated `literal`s, so it validates and serializes exactly as one. Use `union([literal(...)])` directly when the values need no labels. The labels are what this adds. It is spelled `enumOf` because `enum` is a reserved word and an export named `enum` could not be imported under its own name.

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

**`parse()` checks structure, not [constraints](#constraints).** `parse(number({max: 30}), 200)` returns `ok`. Constraints are checked when config is written, not when a value is read back. See [Constraints](#constraints).

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
