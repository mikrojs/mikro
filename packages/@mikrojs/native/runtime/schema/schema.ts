import {err, ok} from 'mikro/result'

import type {Result} from '../result/types.js'
import {type Infer, type Schema, type SchemaError, validate} from './core.js'

export type {
  ArrayOptions,
  ArraySchema,
  BooleanSchema,
  DefaultOption,
  DisplayOptions,
  EnumEntry,
  Format,
  Infer,
  InferRead,
  LiteralSchema,
  MaskableOptions,
  NumberOptions,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  ScalarOptions,
  Schema,
  StringOptions,
  StringSchema,
  TaggedUnionSchema,
  TupleSchema,
  UnionSchema,
  Unit,
  UnknownSchema,
} from './core.js'
export {
  applyDefaults,
  array,
  boolean,
  enumOf,
  literal,
  number,
  object,
  optional,
  SchemaError,
  string,
  taggedUnion,
  tuple,
  union,
  unknown,
} from './core.js'

export function parse<S extends Schema>(schema: S, value: unknown): Result<Infer<S>, SchemaError> {
  const result = validate(schema, value, '')
  if (result !== null) return err(result.error)
  return ok(value as Infer<S>)
}
