import type {Result} from '../result/types.js'

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

export type SchemaError = {name: 'ValidationFailed'; message: string; path: string}

export declare function string(): StringSchema
export declare function number(): NumberSchema
export declare function boolean(): BooleanSchema
export declare function unknown(): UnknownSchema
export declare function literal<T extends Primitive>(value: T): LiteralSchema<T>
export declare function array<S extends Schema>(element: S): ArraySchema<S>
export declare function object<Shape extends Record<string, Schema>>(
  shape: Shape,
): ObjectSchema<Shape>
export declare function tuple<Elements extends readonly Schema[]>(
  elements: [...Elements],
): TupleSchema<Elements>
export declare function optional<S extends Schema>(inner: S): OptionalSchema<S>
export declare function union<Members extends readonly Schema[]>(
  members: [...Members],
): UnionSchema<Members>
export declare function taggedUnion<
  Key extends string,
  Branches extends Record<string, ObjectSchema>,
>(key: Key, branches: Branches): TaggedUnionSchema<Key, Branches>
export declare function parse<S extends Schema>(
  schema: S,
  value: unknown,
): Result<Infer<S>, SchemaError>

export declare const SchemaError: {
  ValidationFailed: (message: string, path: string) => SchemaError
}
