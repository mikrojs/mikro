import {err, ok} from 'mikro/result'

import type {Result} from '../result/types.js'

export const SchemaError = {
  ValidationFailed: (message: string, path: string) =>
    ({name: 'ValidationFailed', message, path}) as const,
}
export type SchemaError = ReturnType<typeof SchemaError.ValidationFailed>

// ── Schema types ────────────────────────────────────────────────────

type Primitive = string | number | boolean

export interface StringSchema {
  readonly kind: 'string'
}

export interface NumberSchema {
  readonly kind: 'number'
}

export interface BooleanSchema {
  readonly kind: 'boolean'
}

export interface UnknownSchema {
  readonly kind: 'unknown'
}

export interface LiteralSchema<T extends Primitive = Primitive> {
  readonly kind: 'literal'
  readonly value: T
}

export interface ArraySchema<S extends Schema = Schema> {
  readonly kind: 'array'
  readonly element: S
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
}

export interface UnionSchema<Members extends readonly Schema[] = readonly Schema[]> {
  readonly kind: 'union'
  readonly members: Members
}

export interface TaggedUnionSchema<
  Key extends string = string,
  Branches extends Record<string, ObjectSchema> = Record<string, ObjectSchema>,
> {
  readonly kind: 'taggedUnion'
  readonly key: Key
  readonly branches: Branches
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
            ? Infer<E>[]
            : S extends ObjectSchema<infer Shape>
              ? Simplify<InferObject<Shape>>
              : S extends TupleSchema<infer Elements>
                ? InferTuple<Elements>
                : S extends OptionalSchema<infer Inner>
                  ? Infer<Inner> | undefined
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

export function string(): StringSchema {
  return {kind: 'string'}
}

export function number(): NumberSchema {
  return {kind: 'number'}
}

export function boolean(): BooleanSchema {
  return {kind: 'boolean'}
}

export function unknown(): UnknownSchema {
  return {kind: 'unknown'}
}

export function literal<T extends Primitive>(value: T): LiteralSchema<T> {
  return {kind: 'literal', value}
}

export function array<S extends Schema>(element: S): ArraySchema<S> {
  return {kind: 'array', element}
}

export function object<Shape extends Record<string, Schema>>(shape: Shape): ObjectSchema<Shape> {
  return {kind: 'object', shape}
}

export function tuple<Elements extends readonly Schema[]>(
  elements: [...Elements],
): TupleSchema<Elements> {
  return {kind: 'tuple', elements}
}

export function optional<S extends Schema>(inner: S): OptionalSchema<S> {
  return {kind: 'optional', inner}
}

export function union<Members extends readonly Schema[]>(
  members: [...Members],
): UnionSchema<Members> {
  return {kind: 'union', members}
}

export function taggedUnion<Key extends string, Branches extends Record<string, ObjectSchema>>(
  key: Key,
  branches: Branches,
): TaggedUnionSchema<Key, Branches> {
  return {kind: 'taggedUnion', key, branches}
}

// ── Parse ───────────────────────────────────────────────────────────

export function parse<S extends Schema>(schema: S, value: unknown): Result<Infer<S>, SchemaError> {
  const result = validate(schema, value, '')
  if (result !== null) return result as Result<Infer<S>, SchemaError>
  return ok(value as Infer<S>)
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validate(
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
        if (fieldSchema.kind === 'optional') {
          if (key in obj) {
            const result = validate(fieldSchema, obj[key], fieldPath)
            if (result !== null) return result
          }
        } else {
          if (!(key in obj))
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
      const branch = schema.branches[tag as string]
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
