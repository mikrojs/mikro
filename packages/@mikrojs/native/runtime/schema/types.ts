import type {Result} from '../result/types.js'

type Primitive = string | number | boolean

export type Format = 'url' | 'hostname' | 'ipv4' | 'mac' | 'email'

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

/* Display annotations, carried by every node a form can render. They never
 * change what validates. Not on optional(): the wrapper expresses absence, the
 * node it wraps expresses identity, so annotations go on the inner. */
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
export interface MaskableOptions<T> extends ScalarOptions<T> {
  readonly mask?: boolean
}
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
export interface EnumEntry<T extends Primitive> {
  readonly value: T
  readonly title?: string
  readonly description?: string
}
type EnumMembers<Entries extends readonly EnumEntry<Primitive>[]> = {
  [K in keyof Entries]: LiteralSchema<Entries[K]['value']>
}

/* Mirrors core.ts: the constructors record a `default` annotation in their
 * return type, which is what lets InferRead see it. */
type Defaulted<S, D> = [D] extends [undefined] ? S : S & {readonly default: unknown}

export declare function string<D extends string | undefined = undefined>(
  options?: StringOptions<D>,
): Defaulted<StringSchema, D>
export declare function number<D extends number | undefined = undefined>(
  options?: NumberOptions<D>,
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
>(element: S, options?: ArrayOptions<D>): Defaulted<ArraySchema<S>, D>
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
export declare function enumOf<
  const Entries extends readonly EnumEntry<Primitive>[],
  D extends Entries[number]['value'] | undefined = undefined,
>(entries: Entries, options?: DefaultOption<D>): Defaulted<UnionSchema<EnumMembers<Entries>>, D>
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
