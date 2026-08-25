/* Host-side implementation of `mikro/schema`. On the device this import
 * resolves to the builtin bundle; here it resolves to the same dependency-free
 * core plus a parse() built on the Node result shim, so config files, tests,
 * and tooling can construct and validate schemas in plain Node. */

import {err, ok} from '@mikrojs/native/runtime/result/native-result.node-shim'
import type {Result} from '@mikrojs/native/runtime/result/types'
import {
  type Infer,
  type Schema,
  type SchemaError,
  validate,
} from '@mikrojs/native/runtime/schema/core'

export type {
  ArraySchema,
  BooleanSchema,
  DefaultOption,
  Infer,
  LiteralSchema,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  ScalarOptions,
  Schema,
  StringSchema,
  TaggedUnionSchema,
  TupleSchema,
  UnionSchema,
  UnknownSchema,
} from '@mikrojs/native/runtime/schema/core'
export {
  applyDefaults,
  array,
  boolean,
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
} from '@mikrojs/native/runtime/schema/core'

export function parse<S extends Schema>(schema: S, value: unknown): Result<Infer<S>, SchemaError> {
  const result = validate(schema, value, '')
  if (result !== null) return err(result.error) as Result<Infer<S>, SchemaError>
  return ok(value) as Result<Infer<S>, SchemaError>
}
