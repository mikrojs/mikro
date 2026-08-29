import {type Infer, type Schema, type SchemaError, validate} from '../core.js'

/* The Result-returning parse() belongs to the `mikro/schema` facades, which is
 * where mikro/result is available; this package stays dependency-free and
 * exposes validate(). The suites below predate the split and read the same
 * three fields either way, so they keep their shape. */
export function parse<S extends Schema>(
  schema: S,
  value: unknown,
): {ok: true; value: Infer<S>} | {ok: false; error: SchemaError} {
  const result = validate(schema, value, '')
  if (result !== null) return {ok: false, error: result.error}
  return {ok: true, value: value as Infer<S>}
}
