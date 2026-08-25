/* Core schema machinery: types, constructors, the validator, and
 * applyDefaults. Dependency-free so hosts (CLI, registries) can import it via
 * shared.ts without resolving mikro/* builtins; mikro/schema re-exports it and
 * adds the Result-returning parse(). */

function err<E>(error: E) {
  return {ok: false as const, error}
}

export const SchemaError = {
  ValidationFailed: (message: string, path: string) =>
    ({name: 'ValidationFailed', message, path}) as const,
}
export type SchemaError = ReturnType<typeof SchemaError.ValidationFailed>

// ── Schema types ────────────────────────────────────────────────────

type Primitive = string | number | boolean

/* The `default` annotation is stored as an extra node property so a schema
 * serializes to JSON as-is; it is typed precisely on the constructor options
 * and loosely on the node, which keeps Infer free of recursive
 * instantiations. */

export interface StringSchema {
  readonly kind: 'string'
  readonly default?: string
}

export interface NumberSchema {
  readonly kind: 'number'
  readonly default?: number
}

export interface BooleanSchema {
  readonly kind: 'boolean'
  readonly default?: boolean
}

export interface UnknownSchema {
  readonly kind: 'unknown'
}

export interface LiteralSchema<T extends Primitive = Primitive> {
  readonly kind: 'literal'
  readonly value: T
  readonly default?: T
}

export interface ArraySchema<S extends Schema = Schema> {
  readonly kind: 'array'
  readonly element: S
  readonly default?: unknown
}

export interface ObjectSchema<Shape extends Record<string, Schema> = Record<string, Schema>> {
  readonly kind: 'object'
  readonly shape: Shape
}

export interface OptionalSchema<S extends Schema = Schema> {
  readonly kind: 'optional'
  readonly inner: S
}

export interface TupleSchema<Elements extends readonly Schema[] = readonly Schema[]> {
  readonly kind: 'tuple'
  readonly elements: Elements
  readonly default?: unknown
}

export interface UnionSchema<Members extends readonly Schema[] = readonly Schema[]> {
  readonly kind: 'union'
  readonly members: Members
  readonly default?: unknown
}

export interface TaggedUnionSchema<
  Key extends string = string,
  Branches extends Record<string, ObjectSchema> = Record<string, ObjectSchema>,
> {
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
 * lockstep with materializeDefaults in shared.ts. */
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

export interface ScalarOptions<T> {
  readonly default?: T
}

export interface DefaultOption<T> {
  readonly default?: T
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

/* Copies the annotation onto the node and rejects a `default` the node itself
 * would not accept, so a bad default fails where it is written. */
function annotate<S extends Schema>(node: S, options?: {default?: unknown}): S {
  if (options === undefined) return node
  const out = node as {default?: unknown}
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
  options?: ScalarOptions<D>,
): Defaulted<StringSchema, D> {
  return annotate<StringSchema>({kind: 'string'}, options) as Defaulted<StringSchema, D>
}

export function number<D extends number | undefined = undefined>(
  options?: ScalarOptions<D>,
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
  options?: DefaultOption<D>,
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
  return {kind: 'object', shape}
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

export function validate(
  schema: Schema,
  value: unknown,
  path: string,
): ReturnType<typeof err<SchemaError>> | null {
  switch (schema.kind) {
    case 'string':
      if (typeof value !== 'string')
        return err(SchemaError.ValidationFailed(`expected string, got ${typeOf(value)}`, path))
      return null

    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value))
        return err(SchemaError.ValidationFailed(`expected number, got ${typeOf(value)}`, path))
      return null

    case 'boolean':
      if (typeof value !== 'boolean')
        return err(SchemaError.ValidationFailed(`expected boolean, got ${typeOf(value)}`, path))
      return null

    case 'unknown':
      return null

    case 'literal':
      if (value !== schema.value)
        return err(
          SchemaError.ValidationFailed(
            `expected ${JSON.stringify(schema.value)}, got ${JSON.stringify(value)}`,
            path,
          ),
        )
      return null

    case 'array': {
      if (!Array.isArray(value))
        return err(SchemaError.ValidationFailed(`expected array, got ${typeOf(value)}`, path))
      for (let i = 0; i < value.length; i++) {
        const result = validate(schema.element, value[i], `${path}[${i}]`)
        if (result !== null) return result
      }
      return null
    }

    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return err(SchemaError.ValidationFailed(`expected object, got ${typeOf(value)}`, path))
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
            const result = validate(fieldSchema, obj[key], fieldPath)
            if (result !== null) return result
          }
        } else {
          if (!Object.hasOwn(obj, key))
            return err(SchemaError.ValidationFailed(`missing required field`, fieldPath))
          const result = validate(fieldSchema, obj[key], fieldPath)
          if (result !== null) return result
        }
      }
      return null
    }

    case 'tuple': {
      if (!Array.isArray(value))
        return err(SchemaError.ValidationFailed(`expected array, got ${typeOf(value)}`, path))
      if (value.length !== schema.elements.length)
        return err(
          SchemaError.ValidationFailed(
            `expected ${schema.elements.length} elements, got ${value.length}`,
            path,
          ),
        )
      for (let i = 0; i < schema.elements.length; i++) {
        const result = validate(schema.elements[i]!, value[i], `${path}[${i}]`)
        if (result !== null) return result
      }
      return null
    }

    case 'optional': {
      if (value === undefined) return null
      return validate(schema.inner, value, path)
    }

    case 'union': {
      for (let i = 0; i < schema.members.length; i++) {
        const result = validate(schema.members[i]!, value, path)
        if (result === null) return null
      }
      return err(SchemaError.ValidationFailed(`value did not match any union member`, path))
    }

    case 'taggedUnion': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return err(SchemaError.ValidationFailed(`expected object, got ${typeOf(value)}`, path))
      const obj = value as Record<string, unknown>
      const tag = obj[schema.key]
      if (tag === undefined)
        return err(
          SchemaError.ValidationFailed(`missing discriminator field`, `${path}.${schema.key}`),
        )
      if (typeof tag !== 'string' && typeof tag !== 'number' && typeof tag !== 'boolean')
        return err(
          SchemaError.ValidationFailed(
            `expected primitive discriminator, got ${typeOf(tag)}`,
            `${path}.${schema.key}`,
          ),
        )
      // hasOwn, not indexing: a tag like "constructor" must not resolve to
      // an inherited property and validate against garbage.
      const branch = Object.hasOwn(schema.branches, tag as string)
        ? schema.branches[tag as string]
        : undefined
      if (branch === undefined)
        return err(
          SchemaError.ValidationFailed(
            `unknown tag ${JSON.stringify(tag)}`,
            `${path}.${schema.key}`,
          ),
        )
      return validate(branch, value, path)
    }
  }
  return err(SchemaError.ValidationFailed(`unknown schema kind: ${(schema as any).kind}`, path))
}
