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

// ── Schema constructors ─────────────────────────────────────────────

export interface ScalarOptions<T> {
  readonly default?: T
}

export interface DefaultOption<T> {
  readonly default?: T
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

export function string(options?: ScalarOptions<string>): StringSchema {
  return annotate({kind: 'string'}, options)
}

export function number(options?: ScalarOptions<number>): NumberSchema {
  return annotate({kind: 'number'}, options)
}

export function boolean(options?: ScalarOptions<boolean>): BooleanSchema {
  return annotate({kind: 'boolean'}, options)
}

export function unknown(): UnknownSchema {
  return {kind: 'unknown'}
}

export function literal<T extends Primitive>(
  value: T,
  options?: ScalarOptions<T>,
): LiteralSchema<T> {
  return annotate({kind: 'literal', value}, options)
}

export function array<S extends Schema>(
  element: S,
  options?: DefaultOption<NoInfer<Infer<S>>[]>,
): ArraySchema<S> {
  return annotate({kind: 'array', element}, options)
}

export function object<Shape extends Record<string, Schema>>(shape: Shape): ObjectSchema<Shape> {
  return {kind: 'object', shape}
}

export function tuple<Elements extends readonly Schema[]>(
  elements: [...Elements],
  options?: DefaultOption<NoInfer<Infer<TupleSchema<Elements>>>>,
): TupleSchema<Elements> {
  return annotate({kind: 'tuple', elements}, options)
}

export function optional<S extends Schema>(inner: S): OptionalSchema<S> {
  if ((inner as {default?: unknown}).default !== undefined) {
    throw new TypeError('optional() cannot wrap a schema with a default')
  }
  return {kind: 'optional', inner}
}

export function union<Members extends readonly Schema[]>(
  members: [...Members],
  options?: DefaultOption<NoInfer<Infer<UnionSchema<Members>>>>,
): UnionSchema<Members> {
  return annotate({kind: 'union', members}, options)
}

export function taggedUnion<Key extends string, Branches extends Record<string, ObjectSchema>>(
  key: Key,
  branches: Branches,
  options?: DefaultOption<NoInfer<Infer<TaggedUnionSchema<Key, Branches>>>>,
): TaggedUnionSchema<Key, Branches> {
  return annotate({kind: 'taggedUnion', key, branches}, options)
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
