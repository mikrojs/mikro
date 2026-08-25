import type {Result} from '../result/types.js'

type Primitive = string | number | boolean

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
 * cannot fill is optional here, while Infer keeps it required. */
export type InferRead<S> =
  S extends ObjectSchema<infer Shape>
    ? ObjectSchema extends S
      ? object
      : Simplify<InferReadObject<Shape>>
    : Infer<S>

/* Kept in lockstep with core.ts (and materializeDefaults in shared.ts). */
type Filled<S> = S extends {default: unknown}
  ? true
  : S extends OptionalSchema
    ? false
    : S extends ObjectSchema<infer Shape>
      ? ObjectSchema extends S
        ? false
        : AllFilled<Shape>
      : false

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

export type SchemaError = {name: 'ValidationFailed'; message: string; path: string}

export interface ScalarOptions<T> {
  readonly default?: T
}
export interface DefaultOption<T> {
  readonly default?: T
}

/* Mirrors core.ts: the constructors record a `default` annotation in their
 * return type, which is what lets InferRead see it. */
type Defaulted<S, D> = [D] extends [undefined] ? S : S & {readonly default: unknown}

export declare function string<D extends string | undefined = undefined>(
  options?: ScalarOptions<D>,
): Defaulted<StringSchema, D>
export declare function number<D extends number | undefined = undefined>(
  options?: ScalarOptions<D>,
): Defaulted<NumberSchema, D>
export declare function boolean<D extends boolean | undefined = undefined>(
  options?: ScalarOptions<D>,
): Defaulted<BooleanSchema, D>
export declare function unknown(): UnknownSchema
export declare function literal<T extends Primitive, D extends T | undefined = undefined>(
  value: T,
  options?: ScalarOptions<D>,
): Defaulted<LiteralSchema<T>, D>
export declare function array<
  S extends Schema,
  D extends NoInfer<Infer<S>>[] | undefined = undefined,
>(element: S, options?: DefaultOption<D>): Defaulted<ArraySchema<S>, D>
export declare function object<Shape extends Record<string, Schema>>(
  shape: Shape,
  options?: DefaultOption<never>,
): ObjectSchema<Shape>
export declare function tuple<
  Elements extends readonly Schema[],
  D extends NoInfer<Infer<TupleSchema<Elements>>> | undefined = undefined,
>(elements: [...Elements], options?: DefaultOption<D>): Defaulted<TupleSchema<Elements>, D>
export declare function optional<S extends Schema>(inner: S): OptionalSchema<S>
export declare function union<
  Members extends readonly Schema[],
  D extends NoInfer<Infer<UnionSchema<Members>>> | undefined = undefined,
>(members: [...Members], options?: DefaultOption<D>): Defaulted<UnionSchema<Members>, D>
export declare function taggedUnion<
  Key extends string,
  Branches extends Record<string, ObjectSchema>,
  D extends NoInfer<Infer<TaggedUnionSchema<Key, Branches>>> | undefined = undefined,
>(
  key: Key,
  branches: Branches,
  options?: DefaultOption<D>,
): Defaulted<TaggedUnionSchema<Key, Branches>, D>
export declare function applyDefaults(schema: Schema, value: unknown): unknown
export declare function parse<S extends Schema>(
  schema: S,
  value: unknown,
): Result<Infer<S>, SchemaError>

export declare const SchemaError: {
  ValidationFailed: (message: string, path: string) => SchemaError
}
