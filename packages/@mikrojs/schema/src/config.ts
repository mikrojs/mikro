/* Host-side helpers for OTA config schemas, used by the CLI and by registries.
 * Nothing here reaches a device: it never validates a schema AST (its manifest
 * copy was written by the CLI) and never derives an overlay. `format` lives
 * here rather than in core.ts because the expressions are a denial-of-service
 * surface a device should not carry, and it has no regex engine to carry them
 * with. Imports core.ts only, so this stays dependency-free; results are plain
 * {ok} shapes for the same reason. */

import {
  applyDefaults,
  type Format,
  type ObjectSchema,
  type Schema,
  SchemaError,
  type Unit,
  validate,
} from './core.js'

export type SchemaCheck<T> = {ok: true; value: T} | {ok: false; error: SchemaError}

/* The format expressions live here, not in core.ts, because core.ts is bundled
 * into the device and a config schema is never validated there. Not a
 * caller-supplied `pattern`: a registry runs these against operator input, so a
 * publisher-supplied regular expression would be a denial-of-service vector. */
const FORMAT_PATTERNS: Record<Format, RegExp> = {
  url: /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/?#]+\S*$/,
  hostname:
    /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
  ipv4: /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/,
  // Separators do not mix: aa:bb-cc:dd:ee:ff is not an address.
  mac: /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$|^([0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
}

export const FORMATS = Object.keys(FORMAT_PATTERNS) as readonly Format[]

/**
 * Validates a value against a config schema, `format` included. `validate()` in
 * core.ts covers shape and every numeric and length bound; this adds the one
 * annotation that stays host-side, so every path that validates an operator's
 * value goes through here rather than calling validate() directly.
 */
export function validateConfig(schema: Schema, value: unknown): SchemaCheck<unknown> {
  const structural = validate(schema, value, '')
  if (structural !== null) return {ok: false, error: structural.error}
  const constraint = checkValueConstraints(schema, value, '')
  if (constraint !== null) return constraint
  return {ok: true, value}
}

/* Mirrors validate()'s walk, applying only `format`. Runs after validate(), so
 * every value here is already the right shape and within its bounds. Kept as a
 * second walk rather than folded into core.ts because the expressions below
 * are a denial-of-service surface a device should not carry, and a device has
 * no regex engine to carry them with. */
function checkValueConstraints(
  schema: Schema,
  value: unknown,
  path: string,
): ReturnType<typeof fail> | null {
  switch (schema.kind) {
    case 'string': {
      const text = value as string
      const {format} = schema
      if (format !== undefined && !FORMAT_PATTERNS[format].test(text)) {
        return fail(`not a valid ${format}`, path)
      }
      // The pattern bounds each label at 63 characters; the whole name has its
      // own limit that no per-label rule can express.
      if (format === 'hostname' && text.length > 253) {
        return fail('not a valid hostname', path)
      }
      return null
    }
    case 'array': {
      const items = value as unknown[]
      for (let i = 0; i < items.length; i++) {
        const result = checkValueConstraints(schema.element, items[i], `${path}[${i}]`)
        if (result !== null) return result
      }
      return null
    }
    case 'object': {
      const obj = value as Record<string, unknown>
      for (const key of Object.keys(schema.shape)) {
        if (!Object.hasOwn(obj, key)) continue
        const result = checkValueConstraints(schema.shape[key]!, obj[key], `${path}.${key}`)
        if (result !== null) return result
      }
      return null
    }
    case 'optional':
      return value === undefined ? null : checkValueConstraints(schema.inner, value, path)
    case 'tuple': {
      const items = value as unknown[]
      for (let i = 0; i < schema.elements.length; i++) {
        const result = checkValueConstraints(schema.elements[i]!, items[i], `${path}[${i}]`)
        if (result !== null) return result
      }
      return null
    }
    case 'union': {
      /* A union accepts what ANY member accepts, so the format pass has to
       * agree with validate(). Applying only the first matching member's
       * format would reject a value a later member allows. validate() has
       * already ruled out members of the wrong shape or out of range, so
       * anything reached here differs only in format. */
      let firstFailure: ReturnType<typeof fail> | null = null
      for (const member of schema.members) {
        if (validate(member, value, '') !== null) continue
        const result = checkValueConstraints(member, value, path)
        if (result === null) return null
        firstFailure ??= result
      }
      return firstFailure
    }
    case 'taggedUnion': {
      const obj = value as Record<string, unknown>
      const branch = schema.branches[obj[schema.key] as string]
      return branch === undefined ? null : checkValueConstraints(branch, value, path)
    }
    default:
      return null
  }
}

/** How a unit relates to the primary it measures in, plus the symbol to render
 *  when the ASCII key is not what a person should read.
 *
 *  `scale` and `offset` exist so a form can show a read-only hint beside a
 *  field ("30000000 us (30 s)"). They MUST NOT be used to convert a stored
 *  value. The registry stores only deviations from the schema defaults and
 *  hashes the effective document for its rev, so a lossy round trip stops a
 *  default-equal value being stripped and two operators entering the same
 *  thing produce different revs. Having the numbers here makes converting look
 *  easy; it is still wrong. */
export interface UnitDefinition {
  readonly primary: Unit
  readonly scale: number
  readonly offset: number
  /* What to render beside the number, when the ASCII key is not it. Absent
   * means the key is already the right symbol. An EMPTY string means render no
   * suffix at all: the dimensionless units are named `/` and `count` in the
   * registry, and "0.8 /" is not something to show an operator. */
  readonly symbol?: string
}

/* Declared as Record<Unit, ...> on purpose: the compiler then refuses a table
 * that is missing a member of the union or carries one that is not in it, so
 * the names are declared once in core.ts and cannot drift from this. */
export const UNITS: Record<Unit, UnitDefinition> = {
  m: {primary: 'm', scale: 1, offset: 0},
  kg: {primary: 'kg', scale: 1, offset: 0},
  s: {primary: 's', scale: 1, offset: 0},
  A: {primary: 'A', scale: 1, offset: 0},
  K: {primary: 'K', scale: 1, offset: 0},
  cd: {primary: 'cd', scale: 1, offset: 0},
  mol: {primary: 'mol', scale: 1, offset: 0},
  Hz: {primary: 'Hz', scale: 1, offset: 0},
  rad: {primary: 'rad', scale: 1, offset: 0},
  sr: {primary: 'sr', scale: 1, offset: 0},
  N: {primary: 'N', scale: 1, offset: 0},
  Pa: {primary: 'Pa', scale: 1, offset: 0},
  J: {primary: 'J', scale: 1, offset: 0},
  W: {primary: 'W', scale: 1, offset: 0},
  C: {primary: 'C', scale: 1, offset: 0},
  V: {primary: 'V', scale: 1, offset: 0},
  F: {primary: 'F', scale: 1, offset: 0},
  Ohm: {primary: 'Ohm', scale: 1, offset: 0, symbol: 'Ω'},
  S: {primary: 'S', scale: 1, offset: 0},
  Wb: {primary: 'Wb', scale: 1, offset: 0},
  T: {primary: 'T', scale: 1, offset: 0},
  H: {primary: 'H', scale: 1, offset: 0},
  Cel: {primary: 'Cel', scale: 1, offset: 0, symbol: '°C'},
  lm: {primary: 'lm', scale: 1, offset: 0},
  lx: {primary: 'lx', scale: 1, offset: 0},
  Bq: {primary: 'Bq', scale: 1, offset: 0},
  Gy: {primary: 'Gy', scale: 1, offset: 0},
  Sv: {primary: 'Sv', scale: 1, offset: 0},
  kat: {primary: 'kat', scale: 1, offset: 0},
  m2: {primary: 'm2', scale: 1, offset: 0, symbol: 'm²'},
  m3: {primary: 'm3', scale: 1, offset: 0, symbol: 'm³'},
  'm/s': {primary: 'm/s', scale: 1, offset: 0},
  'm/s2': {primary: 'm/s2', scale: 1, offset: 0, symbol: 'm/s²'},
  'm3/s': {primary: 'm3/s', scale: 1, offset: 0, symbol: 'm³/s'},
  'W/m2': {primary: 'W/m2', scale: 1, offset: 0, symbol: 'W/m²'},
  'cd/m2': {primary: 'cd/m2', scale: 1, offset: 0, symbol: 'cd/m²'},
  bit: {primary: 'bit', scale: 1, offset: 0},
  'bit/s': {primary: 'bit/s', scale: 1, offset: 0},
  lat: {primary: 'lat', scale: 1, offset: 0},
  lon: {primary: 'lon', scale: 1, offset: 0},
  pH: {primary: 'pH', scale: 1, offset: 0},
  dB: {primary: 'dB', scale: 1, offset: 0},
  dBW: {primary: 'dBW', scale: 1, offset: 0},
  count: {primary: 'count', scale: 1, offset: 0, symbol: ''},
  '/': {primary: '/', scale: 1, offset: 0, symbol: ''},
  '%RH': {primary: '%RH', scale: 1, offset: 0},
  '%EL': {primary: '%EL', scale: 1, offset: 0},
  EL: {primary: 'EL', scale: 1, offset: 0},
  '1/s': {primary: '1/s', scale: 1, offset: 0},
  'S/m': {primary: 'S/m', scale: 1, offset: 0},
  B: {primary: 'B', scale: 1, offset: 0},
  VA: {primary: 'VA', scale: 1, offset: 0},
  VAs: {primary: 'VAs', scale: 1, offset: 0},
  var: {primary: 'var', scale: 1, offset: 0},
  vars: {primary: 'vars', scale: 1, offset: 0},
  'J/m': {primary: 'J/m', scale: 1, offset: 0},
  'kg/m3': {primary: 'kg/m3', scale: 1, offset: 0, symbol: 'kg/m³'},
  deg: {primary: 'deg', scale: 1, offset: 0, symbol: '°'},
  NTU: {primary: 'NTU', scale: 1, offset: 0},
  ms: {primary: 's', scale: 1 / 1000, offset: 0},
  min: {primary: 's', scale: 60, offset: 0},
  h: {primary: 's', scale: 3600, offset: 0},
  MHz: {primary: 'Hz', scale: 1000000, offset: 0},
  kW: {primary: 'W', scale: 1000, offset: 0},
  kVA: {primary: 'VA', scale: 1000, offset: 0},
  kvar: {primary: 'var', scale: 1000, offset: 0},
  Ah: {primary: 'C', scale: 3600, offset: 0},
  Wh: {primary: 'J', scale: 3600, offset: 0},
  kWh: {primary: 'J', scale: 3600000, offset: 0},
  varh: {primary: 'vars', scale: 3600, offset: 0},
  kvarh: {primary: 'vars', scale: 3600000, offset: 0},
  kVAh: {primary: 'VAs', scale: 3600000, offset: 0},
  'Wh/km': {primary: 'J/m', scale: 3.6, offset: 0},
  KiB: {primary: 'B', scale: 1024, offset: 0},
  GB: {primary: 'B', scale: 1e9, offset: 0},
  'Mbit/s': {primary: 'bit/s', scale: 1000000, offset: 0},
  'B/s': {primary: 'bit/s', scale: 8, offset: 0},
  'MB/s': {primary: 'bit/s', scale: 8000000, offset: 0},
  mV: {primary: 'V', scale: 1 / 1000, offset: 0},
  mA: {primary: 'A', scale: 1 / 1000, offset: 0},
  dBm: {primary: 'dBW', scale: 1, offset: -30},
  'ug/m3': {primary: 'kg/m3', scale: 1e-9, offset: 0, symbol: 'µg/m³'},
  'mm/h': {primary: 'm/s', scale: 1 / 3600000, offset: 0},
  'm/h': {primary: 'm/s', scale: 1 / 3600, offset: 0},
  ppm: {primary: '/', scale: 1e-6, offset: 0},
  '/100': {primary: '/', scale: 1 / 100, offset: 0, symbol: '%'},
  '/1000': {primary: '/', scale: 1 / 1000, offset: 0, symbol: '‰'},
  hPa: {primary: 'Pa', scale: 100, offset: 0},
  mm: {primary: 'm', scale: 1 / 1000, offset: 0},
  cm: {primary: 'm', scale: 1 / 100, offset: 0},
  km: {primary: 'm', scale: 1000, offset: 0},
  'km/h': {primary: 'm/s', scale: 1 / 3.6, offset: 0},
  ppb: {primary: '/', scale: 1e-9, offset: 0},
  ppt: {primary: '/', scale: 1e-12, offset: 0},
  VAh: {primary: 'VAs', scale: 3600, offset: 0},
  'mg/l': {primary: 'kg/m3', scale: 1 / 1000, offset: 0},
  'ug/l': {primary: 'kg/m3', scale: 1e-6, offset: 0, symbol: 'µg/l'},
  'g/l': {primary: 'kg/m3', scale: 1, offset: 0},
  us: {primary: 's', scale: 1 / 1000000, offset: 0, symbol: 'µs'},
  kHz: {primary: 'Hz', scale: 1000, offset: 0},
  GHz: {primary: 'Hz', scale: 1000000000, offset: 0},
  mW: {primary: 'W', scale: 1 / 1000, offset: 0},
  uA: {primary: 'A', scale: 1 / 1000000, offset: 0, symbol: 'µA'},
  uV: {primary: 'V', scale: 1 / 1000000, offset: 0, symbol: 'µV'},
  mAh: {primary: 'C', scale: 3.6, offset: 0},
  MiB: {primary: 'B', scale: 1048576, offset: 0},
  kB: {primary: 'B', scale: 1000, offset: 0},
  MB: {primary: 'B', scale: 1000000, offset: 0},
  'kbit/s': {primary: 'bit/s', scale: 1000, offset: 0},
  'KiB/s': {primary: 'bit/s', scale: 8192, offset: 0},
  kohm: {primary: 'Ohm', scale: 1000, offset: 0, symbol: 'kΩ'},
  Mohm: {primary: 'Ohm', scale: 1000000, offset: 0, symbol: 'MΩ'},
  kPa: {primary: 'Pa', scale: 1000, offset: 0},
  bar: {primary: 'Pa', scale: 100000, offset: 0},
  Bd: {primary: '1/s', scale: 1, offset: 0},
}

const MAX_DEPTH = 8

/* Caps on operator-visible annotation strings. A title is a field label and a
 * description a sentence or two; both count toward the caller's encoded-size
 * cap, so bound them here rather than letting one field crowd out a schema. */
const MAX_TITLE_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 500

const KINDS = new Set([
  'string',
  'number',
  'boolean',
  'unknown',
  'literal',
  'array',
  'object',
  'optional',
  'tuple',
  'union',
  'taggedUnion',
])

function fail(message: string, path: string) {
  return {ok: false as const, error: SchemaError.ValidationFailed(message, path)}
}

/* JSON.parse creates `__proto__` as an own key, and downstream walks assign
 * overlay values through `out[key] = …` — with these keys that assignment
 * writes the prototype, not a property. The AST is untrusted, so refuse them
 * outright. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Validates an untrusted serialized schema AST as a config schema: well-formed
 * nodes only, an object at the root, no `unknown()`, no `optional()` around an
 * object or array (an overlay needs every absence to mean exactly one thing),
 * defaults that match their own node, and nesting of at most 8 levels.
 * The size cap is the caller's, since only the caller sees encoded bytes.
 */
export function parseConfigSchema(value: unknown): SchemaCheck<Schema> {
  if (!isPlainObject(value) || (value as {kind?: unknown}).kind !== 'object') {
    return fail('config schema root must be an object()', '')
  }
  const result = walk(value, '', 1)
  if (result !== null) return result
  return {ok: true, value: value as unknown as Schema}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* A default below a wholesale unit never applies: applyDefaults replaces the
 * unit whole, so only the unit's own whole-value default fills anything. The
 * constructors reject it where it is written (core.ts, rejectInnerDefaults);
 * a schema that arrived as JSON ran none of them, so the same rule is enforced
 * here. The whole subtree is walked, not just the plain-object path, because
 * nothing checked a nested unit's contents on the way in. Structure is already
 * validated by `walk`, so a non-node here is left for it to report. */
function rejectInnerDefaults(
  value: unknown,
  path: string,
  unit: string,
  self: string,
): ReturnType<typeof fail> | null {
  if (!isPlainObject(value)) return null
  if (value.default !== undefined) {
    return fail(
      `a default under ${unit} never applies; give ${self} itself a whole-value default instead`,
      path,
    )
  }
  const children: [unknown, string][] = []
  for (const key of ['shape', 'branches'] as const) {
    const map = value[key]
    if (isPlainObject(map)) {
      for (const name of Object.keys(map)) children.push([map[name], `${path}.${name}`])
    }
  }
  for (const key of ['element', 'inner'] as const) {
    if (value[key] !== undefined) children.push([value[key], path])
  }
  for (const key of ['elements', 'members'] as const) {
    const items = value[key]
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) children.push([items[i], `${path}[${i}]`])
    }
  }
  for (const [child, childPath] of children) {
    const result = rejectInnerDefaults(child, childPath, unit, self)
    if (result !== null) return result
  }
  return null
}

function walk(value: unknown, path: string, depth: number): ReturnType<typeof fail> | null {
  if (depth > MAX_DEPTH) return fail(`nesting deeper than ${MAX_DEPTH} levels`, path)
  if (!isPlainObject(value)) return fail('expected a schema node', path)
  const node = value
  const kind = node.kind
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    return fail(`unknown schema kind ${JSON.stringify(kind)}`, path)
  }
  if (kind === 'unknown') return fail('unknown() is not allowed in a config schema', path)

  switch (kind) {
    case 'literal': {
      const t = typeof node.value
      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        return fail('literal value must be a primitive', path)
      }
      break
    }
    case 'array': {
      const result = walk(node.element, `${path}.element`, depth + 1)
      if (result !== null) return result
      const inner = rejectInnerDefaults(node.element, `${path}.element`, 'an array', 'the array')
      if (inner !== null) return inner
      break
    }
    case 'object': {
      if (!isPlainObject(node.shape)) return fail('object shape must be a map', path)
      if (node.default !== undefined) return fail('object() cannot carry a default', path)
      for (const key of Object.keys(node.shape)) {
        if (UNSAFE_KEYS.has(key)) return fail(`unsafe field name ${JSON.stringify(key)}`, path)
        const result = walk(node.shape[key], `${path}.${key}`, depth + 1)
        if (result !== null) return result
      }
      break
    }
    case 'optional': {
      const inner = node.inner
      if (isPlainObject(inner) && (inner.kind === 'object' || inner.kind === 'array')) {
        return fail(`optional() cannot wrap an ${inner.kind} in a config schema`, path)
      }
      if (node.default !== undefined) {
        // The wrapper never carries one (the constructor forbids it); in an
        // untrusted AST it would validate here and then be ignored by
        // applyDefaults, a default that silently never applies.
        return fail('optional() cannot carry a default', path)
      }
      if (isPlainObject(inner) && inner.default !== undefined) {
        return fail('optional() cannot wrap a schema with a default', path)
      }
      const result = walk(inner, path, depth + 1)
      if (result !== null) return result
      break
    }
    case 'tuple':
    case 'union': {
      const items = kind === 'tuple' ? node.elements : node.members
      if (!Array.isArray(items)) return fail(`${kind} items must be an array`, path)
      if (kind === 'union' && items.length === 0) {
        // Unsatisfiable: no value matches an empty union, so it would only
        // fail later, at serve, one device at a time.
        return fail('union needs at least one member', path)
      }
      for (let i = 0; i < items.length; i++) {
        const result = walk(items[i], `${path}[${i}]`, depth + 1)
        if (result !== null) return result
        const unit = kind === 'tuple' ? 'a tuple' : 'a union'
        const inner = rejectInnerDefaults(items[i], `${path}[${i}]`, unit, `the ${kind}`)
        if (inner !== null) return inner
      }
      break
    }
    case 'taggedUnion': {
      if (typeof node.key !== 'string') return fail('taggedUnion key must be a string', path)
      if (!isPlainObject(node.branches)) return fail('taggedUnion branches must be a map', path)
      if (Object.keys(node.branches).length === 0) {
        // Unsatisfiable, like an empty union: it would only fail at serve.
        return fail('taggedUnion needs at least one branch', path)
      }
      for (const tag of Object.keys(node.branches)) {
        if (UNSAFE_KEYS.has(tag)) return fail(`unsafe branch tag ${JSON.stringify(tag)}`, path)
        const branch = node.branches[tag]
        if (!isPlainObject(branch) || branch.kind !== 'object') {
          return fail('taggedUnion branch must be an object()', `${path}.${tag}`)
        }
        const result = walk(branch, `${path}.${tag}`, depth + 1)
        if (result !== null) return result
        const inner = rejectInnerDefaults(branch, `${path}.${tag}`, 'a taggedUnion', 'the union')
        if (inner !== null) return inner
      }
      break
    }
  }

  const annotations = checkAnnotations(node, kind, path)
  if (annotations !== null) return annotations

  if (node.default !== undefined) {
    // Constraint-aware on purpose: the constructors cannot do this any more,
    // since core.ts no longer carries the checks, so a default that breaks its
    // own bound must be caught here, at pack, which is moments later.
    const check = validateConfig(node as unknown as Schema, node.default)
    if (!check.ok) {
      return fail(`default does not match the schema: ${check.error.message}`, path)
    }
  }
  return null
}

/* The constructors' own TypeErrors never run against a JSON-sourced AST, so
 * every annotation the constructors accept is re-checked here. optional() is
 * the wrapper the annotations do not belong on: it expresses absence, the node
 * it wraps expresses identity. */
function checkAnnotations(
  node: Record<string, unknown>,
  kind: string,
  path: string,
): ReturnType<typeof fail> | null {
  const onWrapper = kind === 'optional' || kind === 'unknown'
  const text = (key: 'title' | 'description', max: number) => {
    const value = node[key]
    if (value === undefined) return null
    if (onWrapper) return fail(`${kind}() cannot carry a ${key}; annotate what it wraps`, path)
    if (typeof value !== 'string') return fail(`${key} must be a string`, path)
    if (value.length === 0) return fail(`${key} must not be empty; omit it instead`, path)
    if (value.length > max) return fail(`${key} is longer than ${max} characters`, path)
    return null
  }
  const title = text('title', MAX_TITLE_LENGTH)
  if (title !== null) return title
  const description = text('description', MAX_DESCRIPTION_LENGTH)
  if (description !== null) return description

  if (node.mask !== undefined) {
    if (kind !== 'string' && kind !== 'number') {
      return fail(`mask is only allowed on string() and number()`, path)
    }
    if (typeof node.mask !== 'boolean') return fail('mask must be a boolean', path)
    if (node.mask === true && node.default !== undefined) {
      // A masked field with a default ships the same placeholder credential to
      // every device, which is the opposite of what masking is for. Only when
      // it is actually masked: `mask: false` is the ordinary state and says
      // nothing about defaults.
      return fail('a masked field cannot carry a default', path)
    }
  }
  return checkConstraints(node, kind, path)
}

/* Which constraints each kind accepts, and whether the value must be a
 * non-negative whole number (a count) or merely finite (a bound). */
const CONSTRAINTS_BY_KIND: Record<string, readonly [string, string]> = {
  string: ['minLength', 'maxLength'],
  number: ['min', 'max'],
  array: ['minItems', 'maxItems'],
}
const COUNT_CONSTRAINTS = ['minLength', 'maxLength', 'minItems', 'maxItems']
const ALL_CONSTRAINTS = ['minLength', 'maxLength', 'min', 'max', 'minItems', 'maxItems']

function checkConstraints(
  node: Record<string, unknown>,
  kind: string,
  path: string,
): ReturnType<typeof fail> | null {
  const allowed = CONSTRAINTS_BY_KIND[kind]
  for (const key of ALL_CONSTRAINTS) {
    const value = node[key]
    if (value === undefined) continue
    if (allowed === undefined || !allowed.includes(key)) {
      return fail(`${key} is not allowed on ${kind}()`, path)
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(`${key} must be a finite number`, path)
    }
    if (COUNT_CONSTRAINTS.includes(key) && (!Number.isInteger(value) || value < 0)) {
      return fail(`${key} must be a non-negative whole number`, path)
    }
  }
  if (allowed !== undefined) {
    const [lower, upper] = allowed
    const low = node[lower]
    const high = node[upper]
    if (typeof low === 'number' && typeof high === 'number' && low > high) {
      return fail(`${lower} is greater than ${upper}`, path)
    }
  }
  if (node.integer !== undefined) {
    if (kind !== 'number') return fail('integer is not allowed on ' + kind + '()', path)
    if (typeof node.integer !== 'boolean') return fail('integer must be a boolean', path)
  }
  if (node.unit !== undefined) {
    if (kind !== 'number') return fail(`unit is not allowed on ${kind}()`, path)
    if (typeof node.unit !== 'string' || !Object.hasOwn(UNITS, node.unit)) {
      return fail(`unknown unit ${JSON.stringify(node.unit)}`, path)
    }
  }
  if (node.format !== undefined) {
    if (kind !== 'string') return fail(`format is not allowed on ${kind}()`, path)
    // Fail closed. An unrecognised display annotation may be ignored; an
    // unrecognised constraint may not, since ignoring it means accepting a
    // value the author ruled out. Rejecting at publish puts it in front of the
    // one person who can fix it.
    if (typeof node.format !== 'string' || !FORMATS.includes(node.format as never)) {
      return fail(
        `unknown format ${JSON.stringify(node.format)} (known: ${FORMATS.join(', ')})`,
        path,
      )
    }
  }
  return null
}

/**
 * Derives the overlay to store or serve from operator-supplied values: drops
 * keys the schema does not know, strips values structurally equal to the
 * schema default, and prunes empty objects and arrays. Returns undefined when
 * nothing deviates from the defaults. Wholesale nodes (arrays, tuples, unions)
 * are compared and kept as units; nothing inside them is stripped.
 */
export function deriveOverlay(schema: Schema, values: unknown): unknown {
  switch (schema.kind) {
    case 'object': {
      if (values === undefined) return undefined
      // A defined value of the wrong kind is kept, not dropped: dropping it
      // would derive a clean overlay from garbage, so a typo'd save would
      // succeed while storing nothing and rule 5 would never gate on it.
      // Kept, it fails the merge-validate that every caller runs next.
      if (!isPlainObject(values)) return values
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(schema.shape)) {
        const field = schema.shape[key]!
        const value = values[key]
        if (value === undefined) continue
        const derived =
          field.kind === 'optional'
            ? deriveOverlay(field.inner, value)
            : deriveOverlay(field, value)
        if (derived !== undefined) out[key] = derived
      }
      return Object.keys(out).length > 0 ? out : undefined
    }
    case 'array': {
      if (values === undefined) return undefined
      // Wrong kind kept for the same reason as objects above; only a real
      // empty array prunes (emptiness is never a deliberate overlay state).
      if (!Array.isArray(values)) return values
      if (values.length === 0) return undefined
      if (schema.default !== undefined && structuralEquals(values, schema.default)) {
        return undefined
      }
      return stripDangerousKeys(values)
    }
    default: {
      const fallback = (schema as {default?: unknown}).default
      if (fallback !== undefined && structuralEquals(values, fallback)) return undefined
      return stripDangerousKeys(values)
    }
  }
}

/** Wholesale units travel with their unknown keys intact, but the three
 *  prototype-writing names never survive into a stored or served value:
 *  downstream walks and consumers assign through `out[key]`. */
function stripDangerousKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDangerousKeys)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) continue
      out[key] = stripDangerousKeys(value[key])
    }
    return out
  }
  return value
}

export function structuralEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!structuralEquals(a[i], b[i])) return false
    }
    return true
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
      if (!Object.hasOwn(b, key) || !structuralEquals(a[key], b[key])) return false
    }
    return true
  }
  return false
}

/**
 * The effective config for an overlay: defaults filled in, then validated.
 * What a registry runs before serving and what `ota.config()` runs on read.
 */
export function parseEffective(schema: Schema, overlay: unknown): SchemaCheck<unknown> {
  const effective = applyDefaults(schema, overlay)
  // validateConfig, not validate: this is the gate an operator's config passes
  // through, and constraints only bind if they are checked here.
  const result = validateConfig(schema, effective)
  return result.ok ? {ok: true, value: effective} : result
}

/**
 * The partial defaults a schema materializes with no overrides: every field a
 * default covers, and nothing else. Unlike parseEffective it never fails on a
 * required defaultless field, it omits it. This is what pack bakes into the
 * manifest and what a device reads when it holds no served document.
 *
 * Plain objects compose, so a nested one is included only when defaults fill
 * it completely: a half-filled object would not validate, and the read type
 * makes that field optional anyway. Wholesale units (array, tuple, union,
 * taggedUnion) need a whole-value default on the node itself, matching
 * applyDefaults, where a default inside an element or branch is a form hint.
 * Optional fields rest on absence, so they are omitted too.
 */
export function materializeDefaults(schema: Schema): Record<string, unknown> {
  return schema.kind === 'object' ? fillObject(schema).value : {}
}

/** What defaults cover in an object shape. `complete` (every field covered or
 *  optional) is what makes a NESTED object safe to include. */
function fillObject(node: ObjectSchema): {value: Record<string, unknown>; complete: boolean} {
  const out: Record<string, unknown> = {}
  let complete = true
  for (const key of Object.keys(node.shape)) {
    const field = node.shape[key]!
    if (field.kind === 'optional') continue
    const filled = fillField(field)
    if (filled === undefined) complete = false
    else out[key] = filled.value
  }
  return {value: out, complete}
}

/** The value defaults give one field, or undefined when nothing covers it. */
function fillField(node: Schema): {value: unknown} | undefined {
  if (node.kind === 'object') {
    const filled = fillObject(node)
    return filled.complete ? {value: filled.value} : undefined
  }
  const fallback = (node as {default?: unknown}).default
  return fallback === undefined ? undefined : {value: fallback}
}

/** A node with its annotations removed, recursively, so two schemas can be
 *  compared on structure alone. */
/* Cosmetic: a change to one of these must never read as a structural change. */
const DISPLAY_KEYS = ['default', 'title', 'description', 'mask']

/* Semantic, so they survive stripAnnotations and are reported on their own
 * terms. Stripped only for the type comparison, where a tightened bound must
 * not masquerade as a changed type. */
const CONSTRAINT_KEYS = [
  'minLength',
  'maxLength',
  'min',
  'max',
  'integer',
  'minItems',
  'maxItems',
  'format',
]

/* `unit` renders as a suffix, but it is not cosmetic: it reinterprets every
 * stored value, since `interval: 30` means one thing under `s` and another
 * under `ms`. Nothing fails validation, the device just behaves differently. So
 * it survives stripAnnotations and is reported on its own terms, and is
 * stripped only for the type comparison. */
const SHAPE_KEYS = [...DISPLAY_KEYS, ...CONSTRAINT_KEYS, 'unit']

function stripKeys(node: unknown, keys: readonly string[]): unknown {
  if (!isPlainObject(node)) return node
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(node)) {
    if (keys.includes(key)) continue
    const value = node[key]
    if (key === 'shape' || key === 'branches') {
      const map = value as Record<string, unknown>
      const stripped: Record<string, unknown> = {}
      for (const k of Object.keys(map)) stripped[k] = stripKeys(map[k], keys)
      out[key] = stripped
    } else if (key === 'element' || key === 'inner') {
      out[key] = stripKeys(value, keys)
    } else if (key === 'elements' || key === 'members') {
      out[key] = (value as unknown[]).map((item) => stripKeys(item, keys))
    } else {
      out[key] = value
    }
  }
  return out
}

/** A node reduced to its shape alone, for asking "did the type change?" without
 *  a tightened bound answering yes.
 *
 *  This is now the only comparison the diff makes. Constraints used to be kept
 *  in some comparisons so that a change to one registered as a difference, but
 *  every constraint is reported explicitly by constraintWarnings, and keeping
 *  them here only made a changed bound masquerade as a changed type. */
function stripToShape(node: unknown): unknown {
  return stripKeys(node, SHAPE_KEYS)
}

/* Tightening a bound can invalidate a value an operator already stored, so it
 * gates the same way a removed union member does. Loosening cannot, and is
 * silent. Reported at release time on the schemas alone; rule 5 catches which
 * devices are actually affected when an offer is considered. */
function constraintWarnings(prev: unknown, curr: unknown, path: string, out: string[]): void {
  if (!isPlainObject(prev) || !isPlainObject(curr)) return
  const report = (key: string, lowerIsLooser: boolean): void => {
    const before = prev[key]
    const after = curr[key]
    if (after === undefined) return
    const gate = (how: string): void => {
      out.push(
        `requires an operator: ${path} ${how} ${key} (stored overrides may no longer validate)`,
      )
    }
    if (before === undefined) return gate('added')
    if (typeof before !== 'number' || typeof after !== 'number') return
    if (lowerIsLooser ? after > before : after < before) gate(lowerIsLooser ? 'raised' : 'lowered')
  }
  for (const key of ['min', 'minLength', 'minItems']) report(key, true)
  for (const key of ['max', 'maxLength', 'maxItems']) report(key, false)
  if (curr.integer === true && prev.integer !== true) {
    out.push(
      `requires an operator: ${path} now requires a whole number ` +
        `(stored overrides may no longer validate)`,
    )
  }
  if (curr.format !== undefined && prev.format !== curr.format) {
    out.push(
      `requires an operator: ${path} now requires format ${JSON.stringify(curr.format)} ` +
        `(stored overrides may no longer validate)`,
    )
  }
  if (prev.unit !== curr.unit) {
    out.push(
      `requires an operator: ${path} changed unit from ${JSON.stringify(prev.unit ?? null)} ` +
        `to ${JSON.stringify(curr.unit ?? null)} (stored values are reinterpreted)`,
    )
  }

  /* Descend where the outer walk does not. It recurses through object shapes
   * only, so without this a tightened bound on an array element or a tuple
   * position is silent: stripToShape removes constraints recursively, so the
   * type comparison sees no change, and the checks above only read this node's
   * own keys. A stranded override with no operator gate is exactly what the
   * taxonomy exists to prevent. */
  if (prev.kind === 'array' && curr.kind === 'array') {
    constraintWarnings(prev.element, curr.element, `${path}[]`, out)
  } else if (prev.kind === 'tuple' && curr.kind === 'tuple') {
    const elements = curr.elements as unknown[]
    const previous = prev.elements as unknown[]
    for (let i = 0; i < Math.min(previous.length, elements.length); i++) {
      constraintWarnings(previous[i], elements[i], `${path}[${i}]`, out)
    }
  } else if (prev.kind === 'optional' && curr.kind === 'optional') {
    constraintWarnings(prev.inner, curr.inner, path, out)
  } else if (prev.kind === 'object' && curr.kind === 'object') {
    /* array(object({port: number({max: 65535})})) is an ordinary config shape,
     * and without this the port's tightened bound is silent: the outer walk
     * hands the array to stripToShape, which is equal, and the descent above
     * reaches the element object and stops.
     *
     * No double-reporting with the outer walk: its object branch recurses per
     * field and returns before reaching constraintWarnings, so an object is
     * either walked or descended here, never both. */
    const prevShape = prev.shape as Record<string, unknown>
    const currShape = curr.shape as Record<string, unknown>
    for (const key of Object.keys(currShape)) {
      if (Object.hasOwn(prevShape, key)) {
        constraintWarnings(prevShape[key], currShape[key], `${path}.${key}`, out)
      }
    }
  } else if (prev.kind === 'taggedUnion' && curr.kind === 'taggedUnion') {
    const prevBranches = prev.branches as Record<string, unknown>
    const currBranches = curr.branches as Record<string, unknown>
    for (const tag of Object.keys(currBranches)) {
      if (Object.hasOwn(prevBranches, tag)) {
        constraintWarnings(prevBranches[tag], currBranches[tag], `${path}.${tag}`, out)
      }
    }
  }
}

/** required / defaulted / optional, per the spec's scalar-leaf classes.
 *  Containers have no class; objects report 'object' so the walk descends. */
function leafClass(node: Schema): 'object' | 'optional' | 'defaulted' | 'required' | 'array' {
  if (node.kind === 'optional') return 'optional'
  if (node.kind === 'object') return 'object'
  if (node.kind === 'array') return 'array'
  return (node as {default?: unknown}).default !== undefined ? 'defaulted' : 'required'
}

/** Every required scalar leaf reachable in `node`, for reporting an added
 *  subtree that will gate offers until an operator supplies values. */
function requiredLeaves(node: Schema, path: string, out: string[]): void {
  if (node.kind === 'object') {
    for (const key of Object.keys(node.shape)) {
      requiredLeaves(node.shape[key]!, `${path}.${key}`, out)
    }
    return
  }
  if (leafClass(node) === 'required') out.push(path)
}

/**
 * Human-readable warnings for what changed between two releases' config
 * schemas, per the spec's change taxonomy (registry-spec.md, "Schema changes
 * between releases"). Safe changes (new defaulted or optional fields, added
 * union members, loosened requirements) produce nothing. "requires an
 * operator" lines gate offers under rule 5 until someone supplies or fixes a
 * value; "note" lines are compatible but worth telling the operator about.
 */
export function diffConfigSchemas(previous: Schema, next: Schema): string[] {
  const warnings: string[] = []

  function walk(prev: Schema, curr: Schema, path: string): void {
    const prevInner = prev.kind === 'optional' ? prev.inner : prev
    const currInner = curr.kind === 'optional' ? curr.inner : curr

    if (prevInner.kind === 'object' && currInner.kind === 'object') {
      const prevShape = prevInner.shape
      const currShape = currInner.shape
      for (const key of Object.keys(currShape)) {
        const fieldPath = `${path}.${key}`
        if (Object.hasOwn(prevShape, key)) {
          walk(prevShape[key]!, currShape[key]!, fieldPath)
        } else {
          const added: string[] = []
          requiredLeaves(currShape[key]!, fieldPath, added)
          for (const leaf of added) {
            warnings.push(
              `requires an operator: new required field ${leaf} (devices are not offered ` +
                `this release until a value is set)`,
            )
          }
        }
      }
      for (const key of Object.keys(prevShape)) {
        if (!Object.hasOwn(currShape, key)) {
          warnings.push(
            `note: removed field ${path}.${key} (stored overrides for it stay, but are no ` +
              `longer served)`,
          )
        }
      }
      return
    }

    if (prevInner.kind === 'union' && currInner.kind === 'union') {
      // Member sets, not wholesale structure: adding a member (the common
      // safe widening) must not read as a type change. Only removals can
      // invalidate a stored override.
      /* Counted by shape group, not tested for membership. Comparing on shape
       * is what stops a merely loosened bound reading as a removal, but it also
       * makes two differently bounded members of the same kind indistinguishable
       * here: asking "does a member of this shape still exist?" answers yes when
       * one of the two has gone. Dropping one of
       * union([number({max: 10}), number({min: 100})]) would then be silent,
       * stranding any override only the removed range accepted.
       *
       * A group whose count fell has lost a member. Counting keeps the loosened
       * bound safe, since that leaves the count unchanged. */
      const countOfShape = (members: readonly unknown[], shape: unknown) =>
        members.filter((member) => structuralEquals(stripToShape(member), shape)).length

      let removed = 0
      const groups: unknown[] = []
      for (const prevMember of prevInner.members) {
        const shape = stripToShape(prevMember)
        if (groups.some((seen) => structuralEquals(seen, shape))) continue
        groups.push(shape)
        const before = countOfShape(prevInner.members, shape)
        const after = countOfShape(currInner.members, shape)
        if (after < before) removed += before - after
      }
      if (removed > 0) {
        warnings.push(
          `requires an operator: ${path} removed ${removed} union member(s) ` +
            `(stored overrides using them no longer validate)`,
        )
      }
      // Constraint changes within members, index-wise. Members are ordered and
      // an edit that also reorders them is not something this can attribute, so
      // only compare when the lists still line up.
      if (prevInner.members.length === currInner.members.length) {
        for (let i = 0; i < prevInner.members.length; i++) {
          constraintWarnings(prevInner.members[i], currInner.members[i], `${path}|${i}`, warnings)
        }
      }
    } else if (
      prevInner.kind === 'taggedUnion' &&
      currInner.kind === 'taggedUnion' &&
      prevInner.key === currInner.key
    ) {
      // Same idea per branch: added branches are safe, removed or reshaped
      // ones can strand a stored override.
      for (const tag of Object.keys(prevInner.branches)) {
        const prevBranch = prevInner.branches[tag]!
        const currBranch = currInner.branches[tag]
        if (currBranch === undefined || !Object.hasOwn(currInner.branches, tag)) {
          warnings.push(
            `requires an operator: ${path} removed branch ${JSON.stringify(tag)} ` +
              `(stored overrides using it no longer validate)`,
          )
        } else if (!structuralEquals(stripToShape(prevBranch), stripToShape(currBranch))) {
          // Shape, not constraints: a branch whose bound merely changed has not
          // changed type, and the descent in constraintWarnings reports it on
          // its own terms rather than as a reshaped branch.
          warnings.push(
            `requires an operator: ${path}.${tag} changed type ` +
              `(stored overrides may no longer validate)`,
          )
        }
      }
    } else if (!structuralEquals(stripToShape(prevInner), stripToShape(currInner))) {
      warnings.push(
        `requires an operator: ${path} changed type (stored overrides may no longer validate)`,
      )
      return
    }

    constraintWarnings(prevInner, currInner, path, warnings)

    const prevClass = leafClass(prev)
    const currClass = leafClass(curr)
    if (currClass === 'required' && prevClass !== 'required') {
      warnings.push(
        `requires an operator: ${path} is now required (devices without a value are not ` +
          `offered this release)`,
      )
    }
    const prevDefault = (prevInner as {default?: unknown}).default
    const currDefault = (currInner as {default?: unknown}).default
    // A removed default is the required-transition above, not also a default
    // change.
    if (currDefault !== undefined && !structuralEquals(prevDefault, currDefault)) {
      warnings.push(
        `note: default of ${path} changed (takes effect on every device without an override)`,
      )
    }
  }

  walk(previous, next, '')
  return warnings
}
