# @mikrojs/schema

The schema DSL behind [Mikro.js](https://mikrojs.dev): declare a shape once, infer its
TypeScript type, validate values against it, and serialize it as plain JSON for something
else to read. Zero dependencies, no Node APIs, so it runs on Node, Bun, Deno, Cloudflare
Workers and in a browser.

Apps on a device import `mikro/schema` instead, which is this same DSL backed by a native
module plus a `Result`-returning `parse()`. This package is the host half: the CLI evaluating
`mikro.config.ts`, a registry validating what an operator saves, and anything else that needs
to read a published schema.

```js
import {number, object, string, validate} from '@mikrojs/schema'

const Config = object({
  mqttUrl: string({title: 'Broker URL', format: 'url'}),
  interval: number({title: 'Publish interval', unit: 's', default: 60, min: 1, max: 3600}),
})

validate(Config, {mqttUrl: 'mqtt://box.local', interval: 60}, '') // => null
validate(Config, {mqttUrl: 'mqtt://box.local', interval: 0}, '')
// => {ok: false, error: {name: 'ValidationFailed', message: 'below the minimum of 1', path: '.interval'}}
```

`validate()` returns `null` when the value is good, and covers shape plus every numeric and
length bound. `format` is not checked here; see `@mikrojs/schema/config`.

## Annotations

Nodes carry annotations, and they divide in two. **Display** annotations (`title`,
`description`, `mask`) describe how a value should be presented and never change what
validates, so a consumer may ignore any it does not recognise. **Constraints** (`min`, `max`,
`integer`, `minLength`, `maxLength`, `minItems`, `maxItems`, `format`, `unit`) do change what
validates, and a consumer must not ignore one it does not recognise: ignoring a constraint
means accepting a value the author ruled out.

`unit` is a closed enum following [SenML](https://www.rfc-editor.org/rfc/rfc8428) with ASCII
keys. It is a display hint and constrains nothing. Never convert a stored value through a
unit's scale — see the note beside `UNITS`.

## `@mikrojs/schema/config`

The host-side machinery for Mikro.js OTA config, which is what a registry needs:

- `validateConfig(schema, value)` — `validate()` plus `format`, returning `{ok, value}` or
  `{ok: false, error}`
- `parseConfigSchema(value)` — validate a schema that arrived as JSON, rejecting malformed
  annotations and unknown `format` or `unit` values
- `deriveOverlay` / `parseEffective` / `materializeDefaults` — the sparse-overlay model, where
  a registry stores only deviations from the author's defaults and serves the complete document
- `diffConfigSchemas(previous, next)` — what changed between two releases, and whether it needs
  an operator's attention
- `UNITS`, `FORMATS` — the unit table and the format names

`format` lives here rather than in the main entry for two reasons: the expressions are a
denial-of-service surface a device should not carry, and a device has no regular-expression
engine to carry them with.

The wire format is the contract. It is specified in the
[OTA Registry Spec](https://mikrojs.dev/registry-spec) under "The config schema", and that
document, not this package's version number, is what a third-party registry should build
against.

## Documentation

[mikrojs.dev/api/schema](https://mikrojs.dev/api/schema)
