/* Host-side helpers for config schemas, shared by the CLI and registries.
 * Not part of the mikro/schema device bundle: the device never validates a
 * schema AST (its manifest copy was written by the CLI) and never derives an
 * overlay. Imports core.ts only, so hosts load it without resolving mikro/*
 * builtins; results are plain {ok} shapes for the same reason. */

import {applyDefaults, type ObjectSchema, type Schema, SchemaError, validate} from './core.js'

export type SchemaCheck<T> = {ok: true; value: T} | {ok: false; error: SchemaError}

const MAX_DEPTH = 8

const KINDS = new Set([
  'string',
  'number',
  'boolean',
  'unknown',
  'literal',
  'array',
  'object',
  'optional',
  'tuple',
  'union',
  'taggedUnion',
])

function fail(message: string, path: string) {
  return {ok: false as const, error: SchemaError.ValidationFailed(message, path)}
}

/* JSON.parse creates `__proto__` as an own key, and downstream walks assign
 * overlay values through `out[key] = …` — with these keys that assignment
 * writes the prototype, not a property. The AST is untrusted, so refuse them
 * outright. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Validates an untrusted serialized schema AST as a config schema: well-formed
 * nodes only, an object at the root, no `unknown()`, no `optional()` around an
 * object or array (an overlay needs every absence to mean exactly one thing),
 * defaults that match their own node, and nesting of at most 8 levels.
 * The size cap is the caller's, since only the caller sees encoded bytes.
 */
export function parseConfigSchema(value: unknown): SchemaCheck<Schema> {
  if (!isPlainObject(value) || (value as {kind?: unknown}).kind !== 'object') {
    return fail('config schema root must be an object()', '')
  }
  const result = walk(value, '', 1)
  if (result !== null) return result
  return {ok: true, value: value as unknown as Schema}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* A default below a wholesale unit never applies: applyDefaults replaces the
 * unit whole, so only the unit's own whole-value default fills anything. The
 * constructors reject it where it is written (core.ts, rejectInnerDefaults);
 * a schema that arrived as JSON ran none of them, so the same rule is enforced
 * here. The whole subtree is walked, not just the plain-object path, because
 * nothing checked a nested unit's contents on the way in. Structure is already
 * validated by `walk`, so a non-node here is left for it to report. */
function rejectInnerDefaults(
  value: unknown,
  path: string,
  unit: string,
  self: string,
): ReturnType<typeof fail> | null {
  if (!isPlainObject(value)) return null
  if (value.default !== undefined) {
    return fail(
      `a default under ${unit} never applies; give ${self} itself a whole-value default instead`,
      path,
    )
  }
  const children: [unknown, string][] = []
  for (const key of ['shape', 'branches'] as const) {
    const map = value[key]
    if (isPlainObject(map)) {
      for (const name of Object.keys(map)) children.push([map[name], `${path}.${name}`])
    }
  }
  for (const key of ['element', 'inner'] as const) {
    if (value[key] !== undefined) children.push([value[key], path])
  }
  for (const key of ['elements', 'members'] as const) {
    const items = value[key]
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) children.push([items[i], `${path}[${i}]`])
    }
  }
  for (const [child, childPath] of children) {
    const result = rejectInnerDefaults(child, childPath, unit, self)
    if (result !== null) return result
  }
  return null
}

function walk(value: unknown, path: string, depth: number): ReturnType<typeof fail> | null {
  if (depth > MAX_DEPTH) return fail(`nesting deeper than ${MAX_DEPTH} levels`, path)
  if (!isPlainObject(value)) return fail('expected a schema node', path)
  const node = value
  const kind = node.kind
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    return fail(`unknown schema kind ${JSON.stringify(kind)}`, path)
  }
  if (kind === 'unknown') return fail('unknown() is not allowed in a config schema', path)

  switch (kind) {
    case 'literal': {
      const t = typeof node.value
      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        return fail('literal value must be a primitive', path)
      }
      break
    }
    case 'array': {
      const result = walk(node.element, `${path}.element`, depth + 1)
      if (result !== null) return result
      const inner = rejectInnerDefaults(node.element, `${path}.element`, 'an array', 'the array')
      if (inner !== null) return inner
      break
    }
    case 'object': {
      if (!isPlainObject(node.shape)) return fail('object shape must be a map', path)
      if (node.default !== undefined) return fail('object() cannot carry a default', path)
      for (const key of Object.keys(node.shape)) {
        if (UNSAFE_KEYS.has(key)) return fail(`unsafe field name ${JSON.stringify(key)}`, path)
        const result = walk(node.shape[key], `${path}.${key}`, depth + 1)
        if (result !== null) return result
      }
      break
    }
    case 'optional': {
      const inner = node.inner
      if (isPlainObject(inner) && (inner.kind === 'object' || inner.kind === 'array')) {
        return fail(`optional() cannot wrap an ${inner.kind} in a config schema`, path)
      }
      if (node.default !== undefined) {
        // The wrapper never carries one (the constructor forbids it); in an
        // untrusted AST it would validate here and then be ignored by
        // applyDefaults, a default that silently never applies.
        return fail('optional() cannot carry a default', path)
      }
      if (isPlainObject(inner) && inner.default !== undefined) {
        return fail('optional() cannot wrap a schema with a default', path)
      }
      const result = walk(inner, path, depth + 1)
      if (result !== null) return result
      break
    }
    case 'tuple':
    case 'union': {
      const items = kind === 'tuple' ? node.elements : node.members
      if (!Array.isArray(items)) return fail(`${kind} items must be an array`, path)
      if (kind === 'union' && items.length === 0) {
        // Unsatisfiable: no value matches an empty union, so it would only
        // fail later, at serve, one device at a time.
        return fail('union needs at least one member', path)
      }
      for (let i = 0; i < items.length; i++) {
        const result = walk(items[i], `${path}[${i}]`, depth + 1)
        if (result !== null) return result
        const unit = kind === 'tuple' ? 'a tuple' : 'a union'
        const inner = rejectInnerDefaults(items[i], `${path}[${i}]`, unit, `the ${kind}`)
        if (inner !== null) return inner
      }
      break
    }
    case 'taggedUnion': {
      if (typeof node.key !== 'string') return fail('taggedUnion key must be a string', path)
      if (!isPlainObject(node.branches)) return fail('taggedUnion branches must be a map', path)
      if (Object.keys(node.branches).length === 0) {
        // Unsatisfiable, like an empty union: it would only fail at serve.
        return fail('taggedUnion needs at least one branch', path)
      }
      for (const tag of Object.keys(node.branches)) {
        if (UNSAFE_KEYS.has(tag)) return fail(`unsafe branch tag ${JSON.stringify(tag)}`, path)
        const branch = node.branches[tag]
        if (!isPlainObject(branch) || branch.kind !== 'object') {
          return fail('taggedUnion branch must be an object()', `${path}.${tag}`)
        }
        const result = walk(branch, `${path}.${tag}`, depth + 1)
        if (result !== null) return result
        const inner = rejectInnerDefaults(branch, `${path}.${tag}`, 'a taggedUnion', 'the union')
        if (inner !== null) return inner
      }
      break
    }
  }

  if (node.default !== undefined) {
    const check = validate(node as unknown as Schema, node.default, '')
    if (check !== null) {
      return fail(`default does not match the schema: ${check.error.message}`, path)
    }
  }
  return null
}

/**
 * Derives the overlay to store or serve from operator-supplied values: drops
 * keys the schema does not know, strips values structurally equal to the
 * schema default, and prunes empty objects and arrays. Returns undefined when
 * nothing deviates from the defaults. Wholesale nodes (arrays, tuples, unions)
 * are compared and kept as units; nothing inside them is stripped.
 */
export function deriveOverlay(schema: Schema, values: unknown): unknown {
  switch (schema.kind) {
    case 'object': {
      if (values === undefined) return undefined
      // A defined value of the wrong kind is kept, not dropped: dropping it
      // would derive a clean overlay from garbage, so a typo'd save would
      // succeed while storing nothing and rule 5 would never gate on it.
      // Kept, it fails the merge-validate that every caller runs next.
      if (!isPlainObject(values)) return values
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(schema.shape)) {
        const field = schema.shape[key]!
        const value = values[key]
        if (value === undefined) continue
        const derived =
          field.kind === 'optional'
            ? deriveOverlay(field.inner, value)
            : deriveOverlay(field, value)
        if (derived !== undefined) out[key] = derived
      }
      return Object.keys(out).length > 0 ? out : undefined
    }
    case 'array': {
      if (values === undefined) return undefined
      // Wrong kind kept for the same reason as objects above; only a real
      // empty array prunes (emptiness is never a deliberate overlay state).
      if (!Array.isArray(values)) return values
      if (values.length === 0) return undefined
      if (schema.default !== undefined && structuralEquals(values, schema.default)) {
        return undefined
      }
      return stripDangerousKeys(values)
    }
    default: {
      const fallback = (schema as {default?: unknown}).default
      if (fallback !== undefined && structuralEquals(values, fallback)) return undefined
      return stripDangerousKeys(values)
    }
  }
}

/** Wholesale units travel with their unknown keys intact, but the three
 *  prototype-writing names never survive into a stored or served value:
 *  downstream walks and consumers assign through `out[key]`. */
function stripDangerousKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDangerousKeys)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) continue
      out[key] = stripDangerousKeys(value[key])
    }
    return out
  }
  return value
}

export function structuralEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!structuralEquals(a[i], b[i])) return false
    }
    return true
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
      if (!Object.hasOwn(b, key) || !structuralEquals(a[key], b[key])) return false
    }
    return true
  }
  return false
}

/**
 * The effective config for an overlay: defaults filled in, then validated.
 * What a registry runs before serving and what `ota.config()` runs on read.
 */
export function parseEffective(schema: Schema, overlay: unknown): SchemaCheck<unknown> {
  const effective = applyDefaults(schema, overlay)
  const result = validate(schema, effective, '')
  return result !== null ? result : {ok: true, value: effective}
}

/**
 * The partial defaults a schema materializes with no overrides: every field a
 * default covers, and nothing else. Unlike parseEffective it never fails on a
 * required defaultless field, it omits it. This is what pack bakes into the
 * manifest and what a device reads when it holds no served document.
 *
 * Plain objects compose, so a nested one is included only when defaults fill
 * it completely: a half-filled object would not validate, and the read type
 * makes that field optional anyway. Wholesale units (array, tuple, union,
 * taggedUnion) need a whole-value default on the node itself, matching
 * applyDefaults, where a default inside an element or branch is a form hint.
 * Optional fields rest on absence, so they are omitted too.
 */
export function materializeDefaults(schema: Schema): Record<string, unknown> {
  return schema.kind === 'object' ? fillObject(schema).value : {}
}

/** What defaults cover in an object shape. `complete` (every field covered or
 *  optional) is what makes a NESTED object safe to include. */
function fillObject(node: ObjectSchema): {value: Record<string, unknown>; complete: boolean} {
  const out: Record<string, unknown> = {}
  let complete = true
  for (const key of Object.keys(node.shape)) {
    const field = node.shape[key]!
    if (field.kind === 'optional') continue
    const filled = fillField(field)
    if (filled === undefined) complete = false
    else out[key] = filled.value
  }
  return {value: out, complete}
}

/** The value defaults give one field, or undefined when nothing covers it. */
function fillField(node: Schema): {value: unknown} | undefined {
  if (node.kind === 'object') {
    const filled = fillObject(node)
    return filled.complete ? {value: filled.value} : undefined
  }
  const fallback = (node as {default?: unknown}).default
  return fallback === undefined ? undefined : {value: fallback}
}

/** A node with its annotations removed, recursively, so two schemas can be
 *  compared on structure alone. */
function stripAnnotations(node: unknown): unknown {
  if (!isPlainObject(node)) return node
  const {default: _default, ...rest} = node
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(rest)) {
    const value = rest[key]
    if (key === 'shape' || key === 'branches') {
      const map = value as Record<string, unknown>
      const stripped: Record<string, unknown> = {}
      for (const k of Object.keys(map)) stripped[k] = stripAnnotations(map[k])
      out[key] = stripped
    } else if (key === 'element' || key === 'inner') {
      out[key] = stripAnnotations(value)
    } else if (key === 'elements' || key === 'members') {
      out[key] = (value as unknown[]).map(stripAnnotations)
    } else {
      out[key] = value
    }
  }
  return out
}

/** required / defaulted / optional, per the spec's scalar-leaf classes.
 *  Containers have no class; objects report 'object' so the walk descends. */
function leafClass(node: Schema): 'object' | 'optional' | 'defaulted' | 'required' | 'array' {
  if (node.kind === 'optional') return 'optional'
  if (node.kind === 'object') return 'object'
  if (node.kind === 'array') return 'array'
  return (node as {default?: unknown}).default !== undefined ? 'defaulted' : 'required'
}

/** Every required scalar leaf reachable in `node`, for reporting an added
 *  subtree that will gate offers until an operator supplies values. */
function requiredLeaves(node: Schema, path: string, out: string[]): void {
  if (node.kind === 'object') {
    for (const key of Object.keys(node.shape)) {
      requiredLeaves(node.shape[key]!, `${path}.${key}`, out)
    }
    return
  }
  if (leafClass(node) === 'required') out.push(path)
}

/**
 * Human-readable warnings for what changed between two releases' config
 * schemas, per the spec's change taxonomy (registry-spec.md, "Schema changes
 * between releases"). Safe changes (new defaulted or optional fields, added
 * union members, loosened requirements) produce nothing. "requires an
 * operator" lines gate offers under rule 5 until someone supplies or fixes a
 * value; "note" lines are compatible but worth telling the operator about.
 */
export function diffConfigSchemas(previous: Schema, next: Schema): string[] {
  const warnings: string[] = []

  function walk(prev: Schema, curr: Schema, path: string): void {
    const prevInner = prev.kind === 'optional' ? prev.inner : prev
    const currInner = curr.kind === 'optional' ? curr.inner : curr

    if (prevInner.kind === 'object' && currInner.kind === 'object') {
      const prevShape = prevInner.shape
      const currShape = currInner.shape
      for (const key of Object.keys(currShape)) {
        const fieldPath = `${path}.${key}`
        if (Object.hasOwn(prevShape, key)) {
          walk(prevShape[key]!, currShape[key]!, fieldPath)
        } else {
          const added: string[] = []
          requiredLeaves(currShape[key]!, fieldPath, added)
          for (const leaf of added) {
            warnings.push(
              `requires an operator: new required field ${leaf} (devices are not offered ` +
                `this release until a value is set)`,
            )
          }
        }
      }
      for (const key of Object.keys(prevShape)) {
        if (!Object.hasOwn(currShape, key)) {
          warnings.push(
            `note: removed field ${path}.${key} (stored overrides for it stay, but are no ` +
              `longer served)`,
          )
        }
      }
      return
    }

    if (prevInner.kind === 'union' && currInner.kind === 'union') {
      // Member sets, not wholesale structure: adding a member (the common
      // safe widening) must not read as a type change. Only removals can
      // invalidate a stored override.
      const removed = prevInner.members.filter(
        (prevMember) =>
          !currInner.members.some((currMember) =>
            structuralEquals(stripAnnotations(prevMember), stripAnnotations(currMember)),
          ),
      )
      if (removed.length > 0) {
        warnings.push(
          `requires an operator: ${path} removed ${removed.length} union member(s) ` +
            `(stored overrides using them no longer validate)`,
        )
      }
    } else if (
      prevInner.kind === 'taggedUnion' &&
      currInner.kind === 'taggedUnion' &&
      prevInner.key === currInner.key
    ) {
      // Same idea per branch: added branches are safe, removed or reshaped
      // ones can strand a stored override.
      for (const tag of Object.keys(prevInner.branches)) {
        const prevBranch = prevInner.branches[tag]!
        const currBranch = currInner.branches[tag]
        if (currBranch === undefined || !Object.hasOwn(currInner.branches, tag)) {
          warnings.push(
            `requires an operator: ${path} removed branch ${JSON.stringify(tag)} ` +
              `(stored overrides using it no longer validate)`,
          )
        } else if (!structuralEquals(stripAnnotations(prevBranch), stripAnnotations(currBranch))) {
          warnings.push(
            `requires an operator: ${path}.${tag} changed type ` +
              `(stored overrides may no longer validate)`,
          )
        }
      }
    } else if (!structuralEquals(stripAnnotations(prevInner), stripAnnotations(currInner))) {
      warnings.push(
        `requires an operator: ${path} changed type (stored overrides may no longer validate)`,
      )
      return
    }

    const prevClass = leafClass(prev)
    const currClass = leafClass(curr)
    if (currClass === 'required' && prevClass !== 'required') {
      warnings.push(
        `requires an operator: ${path} is now required (devices without a value are not ` +
          `offered this release)`,
      )
    }
    const prevDefault = (prevInner as {default?: unknown}).default
    const currDefault = (currInner as {default?: unknown}).default
    // A removed default is the required-transition above, not also a default
    // change.
    if (currDefault !== undefined && !structuralEquals(prevDefault, currDefault)) {
      warnings.push(
        `note: default of ${path} changed (takes effect on every device without an override)`,
      )
    }
  }

  walk(previous, next, '')
  return warnings
}
