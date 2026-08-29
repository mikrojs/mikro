/* The schema DSL: types, constructors, the validator, and applyDefaults.
 * Dependency-free and free of Node APIs, so a registry can import it anywhere
 * it runs. This is the host implementation; a device runs the C++ port in
 * @mikrojs/native's mik_schema.cpp, and mikro/schema is that port plus a
 * Result-returning parse(). The two are held together by the conformance
 * corpus (@mikrojs/native scripts/gen-schema-fixtures.js). */

function err<E>(error: E) {
  return {ok: false as const, error}
}

/* Declared outright rather than derived from the factory with ReturnType. The
 * `as const` this replaces existed for the `name` literal type, but it also made
 * every field readonly, which stopped the type reducing against structurally
 * equal error unions elsewhere (kv's KVError carries the same ValidationFailed
 * shape) and broke contextual typing at those call sites. */
export type SchemaError = {name: 'ValidationFailed'; message: string; path: string}
export const SchemaError = {
  ValidationFailed: (message: string, path: string): SchemaError => ({
    name: 'ValidationFailed',
    message,
    path,
  }),
}

// ── Schema types ────────────────────────────────────────────────────

type Primitive = string | number | boolean

/* A closed set of string shapes, deliberately not a caller-supplied regex: a
 * registry validates operator input against a published schema, so a pattern
 * from a publisher would be a denial-of-service vector on the registry (one
 * catastrophic-backtracking expression from anyone who can publish). These are
 * ours, fixed, and linear.
 *
 * `url` means any parseable absolute URL with a scheme, not http and https
 * only: mqtt:// and ws:// are ordinary device-config values. A scheme
 * allowlist is not expressible, which is the gap that would justify extending
 * this. ipv6 is deliberately absent: no demand, and it is the one shape whose
 * check is large enough to be worth its own decision. */
export type Format = 'url' | 'hostname' | 'ipv4' | 'mac' | 'email'

/* The unit an operator sees beside a number, and the one the app reads: the
 * annotation describes the stored value and never converts it.
 *
 * The set is the IANA SenML Units and Secondary Units registries, which is the
 * right basis rather than an invention of ours: ASCII by construction, scoped
 * to constrained devices, and already built on the two-tier model this needs,
 * where a secondary unit derives from a primary by scale and offset. Adopted
 * wholesale, minus the entries SenML marks NOT RECOMMENDED for new producers
 * (we are a new producer), plus the microcontroller units its secondary
 * registry lacks -- it is telemetry-shaped, so it has no us, kHz, mW, uA, mAh,
 * MiB, kohm or Bd.
 *
 * Two deliberate departures, both documented in docs/registry-spec.md:
 * `deg` is kept despite its NOT RECOMMENDED marking, because an operator types
 * degrees and not radians; `d` for day is dropped, because a bare `d` is the
 * SI deci- prefix and RFC 8428 guideline 7 forbids standalone prefix letters.
 *
 * Note SenML's `%` is NOT a percentage -- it is a synonym for the ratio `/`,
 * and the RFC says so explicitly. It is excluded, so a 0-100 field uses `/100`,
 * which a form renders as `%`. */
export type Unit =
  | 'm'
  | 'kg'
  | 's'
  | 'A'
  | 'K'
  | 'cd'
  | 'mol'
  | 'Hz'
  | 'rad'
  | 'sr'
  | 'N'
  | 'Pa'
  | 'J'
  | 'W'
  | 'C'
  | 'V'
  | 'F'
  | 'Ohm'
  | 'S'
  | 'Wb'
  | 'T'
  | 'H'
  | 'Cel'
  | 'lm'
  | 'lx'
  | 'Bq'
  | 'Gy'
  | 'Sv'
  | 'kat'
  | 'm2'
  | 'm3'
  | 'm/s'
  | 'm/s2'
  | 'm3/s'
  | 'W/m2'
  | 'cd/m2'
  | 'bit'
  | 'bit/s'
  | 'lat'
  | 'lon'
  | 'pH'
  | 'dB'
  | 'dBW'
  | 'count'
  | '/'
  | '%RH'
  | '%EL'
  | 'EL'
  | '1/s'
  | 'S/m'
  | 'B'
  | 'VA'
  | 'VAs'
  | 'var'
  | 'vars'
  | 'J/m'
  | 'kg/m3'
  | 'deg'
  | 'NTU'
  | 'ms'
  | 'min'
  | 'h'
  | 'MHz'
  | 'kW'
  | 'kVA'
  | 'kvar'
  | 'Ah'
  | 'Wh'
  | 'kWh'
  | 'varh'
  | 'kvarh'
  | 'kVAh'
  | 'Wh/km'
  | 'KiB'
  | 'GB'
  | 'Mbit/s'
  | 'B/s'
  | 'MB/s'
  | 'mV'
  | 'mA'
  | 'dBm'
  | 'ug/m3'
  | 'mm/h'
  | 'm/h'
  | 'ppm'
  | '/100'
  | '/1000'
  | 'hPa'
  | 'mm'
  | 'cm'
  | 'km'
  | 'km/h'
  | 'ppb'
  | 'ppt'
  | 'VAh'
  | 'mg/l'
  | 'ug/l'
  | 'g/l'
  | 'us'
  | 'kHz'
  | 'GHz'
  | 'mW'
  | 'uA'
  | 'uV'
  | 'mAh'
  | 'MiB'
  | 'kB'
  | 'MB'
  | 'kbit/s'
  | 'KiB/s'
  | 'kohm'
  | 'Mohm'
  | 'kPa'
  | 'bar'
  | 'Bd'

/* The `default` annotation is stored as an extra node property so a schema
 * serializes to JSON as-is; it is typed precisely on the constructor options
 * and loosely on the node, which keeps Infer free of recursive
 * instantiations. */

/* Display annotations, carried by every node a form can render. They never
 * change what validates, so a consumer that does not render a form ignores
 * them. Not on optional(): the wrapper expresses absence, the node it wraps
 * expresses identity, so annotations go on the inner. */
interface Annotated {
  readonly title?: string
  readonly description?: string
}

export interface StringSchema extends Annotated {
  readonly kind: 'string'
  readonly default?: string
  readonly mask?: boolean
  readonly minLength?: number
  readonly maxLength?: number
  readonly format?: Format
}

export interface NumberSchema extends Annotated {
  readonly kind: 'number'
  readonly default?: number
  readonly mask?: boolean
  readonly min?: number
  readonly max?: number
  readonly integer?: boolean
  readonly unit?: Unit
}

export interface BooleanSchema extends Annotated {
  readonly kind: 'boolean'
  readonly default?: boolean
}

export interface UnknownSchema {
  readonly kind: 'unknown'
}

export interface LiteralSchema<T extends Primitive = Primitive> extends Annotated {
  readonly kind: 'literal'
  readonly value: T
  readonly default?: T
}

export interface ArraySchema<S extends Schema = Schema> extends Annotated {
  readonly kind: 'array'
  readonly element: S
  readonly default?: unknown
  readonly minItems?: number
  readonly maxItems?: number
}

export interface ObjectSchema<
  Shape extends Record<string, Schema> = Record<string, Schema>,
> extends Annotated {
  readonly kind: 'object'
  readonly shape: Shape
}

export interface OptionalSchema<S extends Schema = Schema> {
  readonly kind: 'optional'
  readonly inner: S
}

export interface TupleSchema<
  Elements extends readonly Schema[] = readonly Schema[],
> extends Annotated {
  readonly kind: 'tuple'
  readonly elements: Elements
  readonly default?: unknown
}

export interface UnionSchema<
  Members extends readonly Schema[] = readonly Schema[],
> extends Annotated {
  readonly kind: 'union'
  readonly members: Members
  readonly default?: unknown
}

export interface TaggedUnionSchema<
  Key extends string = string,
  Branches extends Record<string, ObjectSchema> = Record<string, ObjectSchema>,
> extends Annotated {
  readonly kind: 'taggedUnion'
  readonly key: Key
  readonly branches: Branches
  readonly default?: unknown
}

export type Schema =
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

// ── Type inference ──────────────────────────────────────────────────

type Simplify<T> = {[K in keyof T]: T[K]} & {}

export type Infer<S> = S extends StringSchema
  ? string
  : S extends NumberSchema
    ? number
    : S extends BooleanSchema
      ? boolean
      : S extends UnknownSchema
        ? unknown
        : S extends LiteralSchema<infer T>
          ? T
          : S extends ArraySchema<infer E>
            ? ArraySchema extends S
              ? []
              : Infer<E>[]
            : S extends ObjectSchema<infer Shape>
              ? ObjectSchema extends S
                ? object
                : Simplify<InferObject<Shape>>
              : S extends TupleSchema<infer Elements>
                ? InferTuple<Elements>
                : S extends OptionalSchema<infer Inner>
                  ? OptionalSchema extends S
                    ? OptionalSchema
                    : Infer<Inner> | undefined
                  : S extends UnionSchema<infer Members>
                    ? InferUnion<Members>
                    : S extends TaggedUnionSchema<infer Key, infer Branches>
                      ? InferTaggedUnion<Key, Branches>
                      : never

type InferObject<Shape> = {
  [K in keyof Shape as Shape[K] extends OptionalSchema ? never : K]: Infer<Shape[K]>
} & {
  [K in keyof Shape as Shape[K] extends OptionalSchema ? K : never]?: Infer<Shape[K]>
}

type InferTuple<Elements> = Elements extends readonly [infer Head, ...infer Tail]
  ? [Infer<Head>, ...InferTuple<Tail>]
  : []

type InferUnion<Members> = Members extends readonly [infer Head, ...infer Tail]
  ? Infer<Head> | InferUnion<Tail>
  : never

type InferTaggedUnion<Key extends string, Branches> = {
  [Tag in keyof Branches & string]: {[K in Key]: Tag} & Infer<Branches[Tag]>
}[keyof Branches & string]

/* The read type: what applyDefaults alone can hand back. A field defaults
 * cannot fill is optional here, while Infer keeps it required: Infer is the
 * write type, where an operator must supply it. */
export type InferRead<S> =
  S extends ObjectSchema<infer Shape>
    ? ObjectSchema extends S
      ? object
      : Simplify<InferReadObject<Shape>>
    : Infer<S>

/* What the materialized defaults always contain: a node carrying its own
 * default, or a plain object whose fields ALL fill (or are optional). A
 * defaultless array and a partially fillable object are omitted whole, so
 * their fields read as absent until a document supplies them. Must stay in
 * lockstep with materializeDefaults in config.ts. */
type Filled<S> = S extends {default: unknown}
  ? true
  : S extends OptionalSchema
    ? false
    : S extends ObjectSchema<infer Shape>
      ? ObjectSchema extends S
        ? false
        : AllFilled<Shape>
      : false

/* Every field fills or is optional; an empty shape fills as {}. */
type AllFilled<Shape> = false extends {
  [K in keyof Shape]: Shape[K] extends OptionalSchema ? true : Filled<Shape[K]>
}[keyof Shape]
  ? false
  : true

type InferReadObject<Shape> = {
  [K in keyof Shape as Filled<Shape[K]> extends true ? K : never]: InferRead<Shape[K]>
} & {
  [K in keyof Shape as Filled<Shape[K]> extends true ? never : K]?: InferRead<Shape[K]>
}

// ── Schema constructors ─────────────────────────────────────────────

/* Display annotations every constructor accepts. Structural arguments stay
 * positional; annotations trail. */
export interface DisplayOptions {
  readonly title?: string
  readonly description?: string
}

export interface ScalarOptions<T> extends DisplayOptions {
  readonly default?: T
}

export interface DefaultOption<T> extends DisplayOptions {
  readonly default?: T
}

/* `mask` says: do not display this value in cleartext. A form renders a
 * password input, and any other consumer that prints a config document
 * redacts. It is a display rule and nothing more: the value is stored,
 * transmitted and held on the device in plaintext exactly as any other. */
export interface MaskableOptions<T> extends ScalarOptions<T> {
  readonly mask?: boolean
}

/* Constraints, unlike the display annotations, change what validates. A
 * consumer may ignore an annotation it does not recognise; it may not ignore
 * one of these, since doing so means accepting a value the author ruled out. */
export interface StringOptions<T> extends MaskableOptions<T> {
  readonly minLength?: number
  readonly maxLength?: number
  readonly format?: Format
}

export interface NumberOptions<T> extends MaskableOptions<T> {
  readonly min?: number
  readonly max?: number
  readonly integer?: boolean
  readonly unit?: Unit
}

export interface ArrayOptions<T> extends DefaultOption<T> {
  readonly minItems?: number
  readonly maxItems?: number
}

/* A node interface types `default` as optional, so a defaulted node and a bare
 * one are the same type; the constructors record the annotation in their
 * return type instead, which is what lets InferRead see it. D is the inferred
 * type of the `default` option, undefined when none was written. */
type Defaulted<S, D> = [D] extends [undefined] ? S : S & {readonly default: unknown}

/* Defaults below a wholesale unit never fill: applyDefaults replaces the unit
 * whole, so only a unit-level default applies. Rejected where they are written
 * rather than at the validation that later misses the field. The walk stops at
 * a nested unit's own default, since that unit's constructor already cleared
 * everything under it. */
function rejectInnerDefaults(node: Schema, path: string, unit: string, self: string): void {
  if ((node as {default?: unknown}).default !== undefined) {
    throw new TypeError(
      `a default under ${unit} never applies; give ${self} itself a whole-value ` +
        `default instead (found at ${path})`,
    )
  }
  if (node.kind === 'object') {
    const keys = Object.keys(node.shape)
    for (let i = 0; i < keys.length; i++) {
      rejectInnerDefaults(node.shape[keys[i]!]!, `${path}.${keys[i]!}`, unit, self)
    }
  } else if (node.kind === 'optional') {
    // optional() rejects an inner default itself, so this only reaches what it
    // wraps without reporting the same node twice.
    rejectInnerDefaults(node.inner, path, unit, self)
  }
}

/* Copies the annotations onto the node and rejects a `default` whose *shape*
 * the node would not accept, so an obviously wrong default fails where it is
 * written. Annotations live on the node so a schema serializes to JSON as-is.
 *
 * Constraints are deliberately not checked here, because validate() below does
 * not carry them: see its comment. A default that breaks its own bound is
 * caught by parseConfigSchema in config.ts, which runs when the config is
 * packed, moments after this. */
const ANNOTATION_KEYS = [
  'title',
  'description',
  'mask',
  'minLength',
  'maxLength',
  'min',
  'max',
  'integer',
  'minItems',
  'maxItems',
  'format',
  'unit',
] as const

/* Every annotation any constructor accepts. Interfaces have no index
 * signature, so the copy below reads through a Record view of this. */
type AnyOptions = DisplayOptions &
  Partial<
    Record<'mask' | 'integer', boolean> &
      Record<'minLength' | 'maxLength' | 'min' | 'max' | 'minItems' | 'maxItems', number> & {
        default: unknown
      }
  >

function annotate<S extends Schema>(node: S, options?: AnyOptions): S {
  if (options === undefined) return node
  const out = node as unknown as Record<string, unknown>
  const src = options as Record<string, unknown>
  for (let i = 0; i < ANNOTATION_KEYS.length; i++) {
    const key = ANNOTATION_KEYS[i]!
    if (src[key] !== undefined) out[key] = src[key]
  }
  if (options.default !== undefined) {
    out.default = options.default
    const result = validate(node, options.default, '')
    if (result !== null) {
      throw new TypeError(`schema default does not match the schema: ${result.error.message}`)
    }
  }
  return node
}

export function string<D extends string | undefined = undefined>(
  options?: StringOptions<D>,
): Defaulted<StringSchema, D> {
  return annotate<StringSchema>({kind: 'string'}, options) as Defaulted<StringSchema, D>
}

export function number<D extends number | undefined = undefined>(
  options?: NumberOptions<D>,
): Defaulted<NumberSchema, D> {
  return annotate<NumberSchema>({kind: 'number'}, options) as Defaulted<NumberSchema, D>
}

export function boolean<D extends boolean | undefined = undefined>(
  options?: ScalarOptions<D>,
): Defaulted<BooleanSchema, D> {
  return annotate<BooleanSchema>({kind: 'boolean'}, options) as Defaulted<BooleanSchema, D>
}

export function unknown(): UnknownSchema {
  return {kind: 'unknown'}
}

export function literal<T extends Primitive, D extends T | undefined = undefined>(
  value: T,
  options?: ScalarOptions<D>,
): Defaulted<LiteralSchema<T>, D> {
  return annotate<LiteralSchema<T>>({kind: 'literal', value}, options) as Defaulted<
    LiteralSchema<T>,
    D
  >
}

export function array<S extends Schema, D extends NoInfer<Infer<S>>[] | undefined = undefined>(
  element: S,
  options?: ArrayOptions<D>,
): Defaulted<ArraySchema<S>, D> {
  rejectInnerDefaults(element, '[]', 'an array', 'the array')
  return annotate<ArraySchema<S>>({kind: 'array', element}, options) as Defaulted<ArraySchema<S>, D>
}

export function object<Shape extends Record<string, Schema>>(
  shape: Shape,
  options?: DefaultOption<never>,
): ObjectSchema<Shape> {
  if (options?.default !== undefined) {
    throw new TypeError(
      "an object's defaults compose from its fields; declare defaults on the fields",
    )
  }
  return annotate<ObjectSchema<Shape>>({kind: 'object', shape}, options)
}

export function tuple<
  Elements extends readonly Schema[],
  D extends NoInfer<Infer<TupleSchema<Elements>>> | undefined = undefined,
>(elements: [...Elements], options?: DefaultOption<D>): Defaulted<TupleSchema<Elements>, D> {
  for (let i = 0; i < elements.length; i++) {
    rejectInnerDefaults(elements[i]!, `[${i}]`, 'a tuple', 'the tuple')
  }
  return annotate<TupleSchema<Elements>>({kind: 'tuple', elements}, options) as Defaulted<
    TupleSchema<Elements>,
    D
  >
}

export function optional<S extends Schema>(inner: S): OptionalSchema<S> {
  if ((inner as {default?: unknown}).default !== undefined) {
    throw new TypeError('optional() cannot wrap a schema with a default')
  }
  return {kind: 'optional', inner}
}

export function union<
  Members extends readonly Schema[],
  D extends NoInfer<Infer<UnionSchema<Members>>> | undefined = undefined,
>(members: [...Members], options?: DefaultOption<D>): Defaulted<UnionSchema<Members>, D> {
  for (let i = 0; i < members.length; i++) {
    rejectInnerDefaults(members[i]!, `[${i}]`, 'a union', 'the union')
  }
  return annotate<UnionSchema<Members>>({kind: 'union', members}, options) as Defaulted<
    UnionSchema<Members>,
    D
  >
}

/* A closed list of values with a label for each, which is what a form renders
 * as a select or a radio group.
 *
 * Sugar, not a node kind: it builds a union of annotated literals, so nothing
 * downstream has to learn about it. parseConfigSchema already rejects an empty
 * union, and diffConfigSchemas already reports a removed member as requiring an
 * operator, which is exactly what a dropped choice is.
 *
 * Use union([literal(...)]) directly when the values need no labels; labels are
 * the whole point of this one. Named enumOf because `enum` is a reserved word:
 * an export called `enum` could not be imported under its own name. */
export interface EnumEntry<T extends Primitive> {
  readonly value: T
  readonly title?: string
  readonly description?: string
}

type EnumMembers<Entries extends readonly EnumEntry<Primitive>[]> = {
  [K in keyof Entries]: LiteralSchema<Entries[K]['value']>
}

export function enumOf<
  const Entries extends readonly EnumEntry<Primitive>[],
  D extends Entries[number]['value'] | undefined = undefined,
>(entries: Entries, options?: DefaultOption<D>): Defaulted<UnionSchema<EnumMembers<Entries>>, D> {
  const members = entries.map((entry) =>
    literal(entry.value, {title: entry.title, description: entry.description}),
  ) as unknown as EnumMembers<Entries>
  return annotate<UnionSchema<EnumMembers<Entries>>>(
    {kind: 'union', members},
    options,
  ) as Defaulted<UnionSchema<EnumMembers<Entries>>, D>
}

export function taggedUnion<
  Key extends string,
  Branches extends Record<string, ObjectSchema>,
  D extends NoInfer<Infer<TaggedUnionSchema<Key, Branches>>> | undefined = undefined,
>(
  key: Key,
  branches: Branches,
  options?: DefaultOption<D>,
): Defaulted<TaggedUnionSchema<Key, Branches>, D> {
  const tags = Object.keys(branches)
  for (let i = 0; i < tags.length; i++) {
    rejectInnerDefaults(branches[tags[i]!]!, `.${tags[i]!}`, 'a taggedUnion', 'the union')
  }
  return annotate<TaggedUnionSchema<Key, Branches>>(
    {kind: 'taggedUnion', key, branches},
    options,
  ) as Defaulted<TaggedUnionSchema<Key, Branches>, D>
}

// ── Defaults ────────────────────────────────────────────────────────

/* Builds the effective value: schema defaults with `value` layered over them.
 * Objects are structure and always materialize (recursing per field, unknown
 * keys dropped); every other node is replaced wholesale by a present value, so
 * defaults inside array elements or union branches are form hints, not fills.
 * The result is unvalidated — a missing required field stays missing for
 * parse() to report. */
export function applyDefaults(schema: Schema, value: unknown): unknown {
  switch (schema.kind) {
    case 'object': {
      // A present non-object stays as-is so validation rejects it; replacing
      // it with {} here would make `{mqtt: 42}` validate clean and never
      // record a configError.
      if (
        value !== undefined &&
        (typeof value !== 'object' || value === null || Array.isArray(value))
      ) {
        return value
      }
      const src = value === undefined ? {} : (value as Record<string, unknown>)
      const out: Record<string, unknown> = {}
      const keys = Object.keys(schema.shape)
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!
        const field = schema.shape[key]!
        // hasOwn, not indexing: a shape key like "constructor" must read as
        // absent, not as the inherited prototype member.
        const raw = Object.hasOwn(src, key) ? src[key] : undefined
        if (field.kind === 'optional') {
          if (raw !== undefined) out[key] = raw
        } else {
          const child = applyDefaults(field, raw)
          if (child !== undefined) out[key] = child
        }
      }
      return out
    }
    case 'array':
      if (value !== undefined) return value
      return schema.default !== undefined ? schema.default : []
    case 'unknown':
    case 'optional':
      return value
    default:
      return value !== undefined ? value : (schema as {default?: unknown}).default
  }
}

// ── Parse ───────────────────────────────────────────────────────────

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/* Shape, plus the bounds a value has to satisfy: min, max, integer, minLength,
 * maxLength, minItems, maxItems. `format` and `unit` are the exceptions and
 * stay in config.ts — format needs regular expressions the device has no
 * engine for, and unit is a display hint that constrains nothing.
 *
 * These used to be host-only, because carrying them here charged every app
 * that imports mikro/schema about 4 KB of heap. That argument died when the
 * device stopped running this file: mik_schema.cpp is what a device executes,
 * and a bound there is a few comparisons. Keep the two in step — the corpus in
 * scripts/gen-schema-fixtures.js is what says whether they are.
 *
 * One node is checked completely before the walk moves on, so a value that is
 * both misshapen and out of bounds reports whichever comes first in schema
 * order rather than every structural error ahead of every bound. */
export function validate(
  schema: Schema,
  value: unknown,
  path: string,
): ReturnType<typeof err<SchemaError>> | null {
  const fault = walk(schema, value, path)
  if (fault === null) return null
  return err(SchemaError.ValidationFailed(fault.message, fault.path))
}

/* `bound` separates "the wrong shape" from "the right shape, out of range",
 * which only the union case needs: it reports a member's bound rather than the
 * generic no-member-matched line, because "above the maximum of 100" is what
 * an operator can act on. */
type Fault = {message: string; path: string; bound: boolean}

function shape(message: string, path: string): Fault {
  return {message, path, bound: false}
}

function bound(message: string, path: string): Fault {
  return {message, path, bound: true}
}

function walk(schema: Schema, value: unknown, path: string): Fault | null {
  switch (schema.kind) {
    case 'string': {
      if (typeof value !== 'string') return shape(`expected string, got ${typeOf(value)}`, path)
      const {minLength, maxLength} = schema
      if (minLength !== undefined && value.length < minLength)
        return bound(`shorter than ${minLength} characters`, path)
      if (maxLength !== undefined && value.length > maxLength)
        return bound(`longer than ${maxLength} characters`, path)
      return null
    }

    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value))
        return shape(`expected number, got ${typeOf(value)}`, path)
      const {min, max} = schema
      if (schema.integer === true && !Number.isInteger(value))
        return bound(`expected a whole number, got ${value}`, path)
      if (min !== undefined && value < min) return bound(`below the minimum of ${min}`, path)
      if (max !== undefined && value > max) return bound(`above the maximum of ${max}`, path)
      return null
    }

    case 'boolean':
      if (typeof value !== 'boolean') return shape(`expected boolean, got ${typeOf(value)}`, path)
      return null

    case 'unknown':
      return null

    case 'literal':
      if (value !== schema.value)
        return shape(`expected ${JSON.stringify(schema.value)}, got ${JSON.stringify(value)}`, path)
      return null

    case 'array': {
      if (!Array.isArray(value)) return shape(`expected array, got ${typeOf(value)}`, path)
      const {minItems, maxItems} = schema
      if (minItems !== undefined && value.length < minItems)
        return bound(`fewer than ${minItems} items`, path)
      if (maxItems !== undefined && value.length > maxItems)
        return bound(`more than ${maxItems} items`, path)
      for (let i = 0; i < value.length; i++) {
        const result = walk(schema.element, value[i], `${path}[${i}]`)
        if (result !== null) return result
      }
      return null
    }

    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return shape(`expected object, got ${typeOf(value)}`, path)
      const obj = value as Record<string, unknown>
      const keys = Object.keys(schema.shape)
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!
        const fieldSchema = schema.shape[key]!
        const fieldPath = `${path}.${key}`
        // hasOwn, like the taggedUnion dispatch: an inherited "constructor"
        // must not stand in for a field.
        if (fieldSchema.kind === 'optional') {
          if (Object.hasOwn(obj, key)) {
            const result = walk(fieldSchema, obj[key], fieldPath)
            if (result !== null) return result
          }
        } else {
          if (!Object.hasOwn(obj, key)) return shape(`missing required field`, fieldPath)
          const result = walk(fieldSchema, obj[key], fieldPath)
          if (result !== null) return result
        }
      }
      return null
    }

    case 'tuple': {
      if (!Array.isArray(value)) return shape(`expected array, got ${typeOf(value)}`, path)
      if (value.length !== schema.elements.length)
        return shape(`expected ${schema.elements.length} elements, got ${value.length}`, path)
      for (let i = 0; i < schema.elements.length; i++) {
        const result = walk(schema.elements[i]!, value[i], `${path}[${i}]`)
        if (result !== null) return result
      }
      return null
    }

    case 'optional': {
      if (value === undefined) return null
      return walk(schema.inner, value, path)
    }

    case 'union': {
      /* A union accepts what ANY member accepts, bounds included: in
       * union([number({max: 10}), number({min: 100})]), 150 matches the first
       * member's shape, breaks its bound, and the second member exists for
       * exactly that value.
       *
       * When nothing passes, a member that had the right shape and only broke
       * a bound gives the better message: "above the maximum of 100" tells an
       * operator what to do, and the generic line does not. A member of the
       * wrong shape says nothing useful about a union of mixed shapes, so
       * those fall through to the generic line. */
      let outOfRange: Fault | null = null
      for (let i = 0; i < schema.members.length; i++) {
        const result = walk(schema.members[i]!, value, path)
        if (result === null) return null
        if (result.bound) outOfRange ??= result
      }
      return outOfRange ?? shape(`value did not match any union member`, path)
    }

    case 'taggedUnion': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return shape(`expected object, got ${typeOf(value)}`, path)
      const obj = value as Record<string, unknown>
      const tag = obj[schema.key]
      if (tag === undefined) return shape(`missing discriminator field`, `${path}.${schema.key}`)
      if (typeof tag !== 'string' && typeof tag !== 'number' && typeof tag !== 'boolean')
        return shape(
          `expected primitive discriminator, got ${typeOf(tag)}`,
          `${path}.${schema.key}`,
        )
      // hasOwn, not indexing: a tag like "constructor" must not resolve to
      // an inherited property and validate against garbage.
      const branch = Object.hasOwn(schema.branches, tag as string)
        ? schema.branches[tag as string]
        : undefined
      if (branch === undefined)
        return shape(`unknown tag ${JSON.stringify(tag)}`, `${path}.${schema.key}`)
      return walk(branch, value, path)
    }
  }
  return shape(`unknown schema kind: ${(schema as any).kind}`, path)
}
