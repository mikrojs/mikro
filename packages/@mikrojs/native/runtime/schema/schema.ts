/* mikro/schema. The constructors, the validator and applyDefaults are native
 * (src/mik_schema.cpp); all this adds is the Result-returning parse(), which
 * is the only part that needs mikro/result.
 *
 * @mikrojs/schema is the same DSL in TypeScript and is what the host
 * runs (the CLI evaluating mikro.config.ts, the registry, vitest). The two are
 * held together by scripts/gen-schema-fixtures.js and
 * test/schema_conformance_test.cpp — change core.ts first, then mik_schema.cpp.
 *
 * validate() is deliberately not re-exported: parse() is the public entry, and
 * that has been true since this module was bytecode. */

import {err, ok} from 'mikro/result'
import {validate} from 'native:mikro/schema'

import type {Result} from '../result/types.js'
import type {Infer, Schema, SchemaError} from './types.js'

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
} from './types.js'
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
} from 'native:mikro/schema'

export function parse<S extends Schema>(schema: S, value: unknown): Result<Infer<S>, SchemaError> {
  const result = validate(schema, value, '')
  if (result !== null) return err(result.error)
  return ok(value as Infer<S>)
}
