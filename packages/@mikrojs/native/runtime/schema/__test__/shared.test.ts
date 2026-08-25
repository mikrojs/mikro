import {describe, expect, it} from 'vitest'

import {array, literal, number, object, optional, string, taggedUnion, union} from '../schema.js'
import {
  deriveOverlay,
  diffConfigSchemas,
  parseConfigSchema,
  parseEffective,
  structuralEquals,
} from '../shared.js'

const config = object({
  mqttUrl: string(),
  interval: number({default: 60}),
  apiKey: optional(string()),
  logLevel: union([literal('debug'), literal('info')], {default: 'info'}),
  tags: array(string()),
  label: optional(string()),
  net: taggedUnion('mode', {
    dhcp: object({}),
    static: object({ip: string(), gateway: string()}),
  }),
})

describe('parseConfigSchema', () => {
  it('accepts a serialized config schema round-tripped through JSON', () => {
    const result = parseConfigSchema(JSON.parse(JSON.stringify(config)))
    expect(result.ok).toBe(true)
  })

  it('requires an object at the root', () => {
    const result = parseConfigSchema(JSON.parse(JSON.stringify(string())))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('root must be an object')
  })

  it('rejects unknown()', () => {
    const result = parseConfigSchema({kind: 'object', shape: {x: {kind: 'unknown'}}})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('unknown()')
      expect(result.error.path).toBe('.x')
    }
  })

  it('rejects optional() around containers', () => {
    for (const inner of [object({}), array(string())] as const) {
      const ast = JSON.parse(JSON.stringify(object({x: optional(inner as never)})))
      const result = parseConfigSchema(ast)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toContain('optional() cannot wrap')
    }
  })

  it('rejects unknown node kinds and malformed nodes', () => {
    expect(parseConfigSchema({kind: 'object', shape: {x: {kind: 'flag'}}}).ok).toBe(false)
    expect(parseConfigSchema({kind: 'object', shape: {x: null}}).ok).toBe(false)
    expect(parseConfigSchema('nope').ok).toBe(false)
  })

  it('rejects a default that does not validate (hand-built AST)', () => {
    const ast = {kind: 'object', shape: {x: {kind: 'number', default: 'oops'}}}
    const result = parseConfigSchema(ast)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('default does not match')
  })

  // JSON.parse creates `__proto__` as an own key, and downstream walks
  // assign overlay values through `out[key] = …`, which for these keys
  // writes the prototype instead of a property.
  it('rejects prototype-polluting field names and branch tags', () => {
    const shape = JSON.parse('{"kind":"object","shape":{"__proto__":{"kind":"string"}}}')
    const result = parseConfigSchema(shape)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('unsafe field name')

    const branches = parseConfigSchema({
      kind: 'object',
      shape: {
        net: {
          kind: 'taggedUnion',
          key: 'mode',
          branches: {constructor: {kind: 'object', shape: {}}},
        },
      },
    })
    expect(branches.ok).toBe(false)
    if (!branches.ok) expect(branches.error.message).toContain('unsafe branch tag')
  })

  // No value matches an empty union or a branchless taggedUnion; both would
  // only fail at serve, one device at a time.
  it('rejects an empty union and a branchless taggedUnion (hand-built AST)', () => {
    const emptyUnion = parseConfigSchema({
      kind: 'object',
      shape: {x: {kind: 'union', members: []}},
    })
    expect(emptyUnion.ok).toBe(false)
    if (!emptyUnion.ok) expect(emptyUnion.error.message).toContain('at least one member')

    const branchless = parseConfigSchema({
      kind: 'object',
      shape: {x: {kind: 'taggedUnion', key: 'mode', branches: {}}},
    })
    expect(branchless.ok).toBe(false)
    if (!branchless.ok) expect(branchless.error.message).toContain('at least one branch')
  })

  it('rejects a default on the optional wrapper itself (hand-built AST)', () => {
    const ast = {
      kind: 'object',
      shape: {x: {kind: 'optional', default: 'y', inner: {kind: 'string'}}},
    }
    const result = parseConfigSchema(ast)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('optional() cannot carry a default')
  })

  it('rejects nesting deeper than 8 levels', () => {
    let node: Record<string, unknown> = {kind: 'string'}
    for (let i = 0; i < 9; i++) node = {kind: 'object', shape: {n: node}}
    const result = parseConfigSchema(node)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('deeper than')
  })
})

describe('deriveOverlay', () => {
  it('returns undefined when nothing deviates from defaults', () => {
    expect(deriveOverlay(config, {interval: 60, logLevel: 'info'})).toBeUndefined()
    expect(deriveOverlay(config, {})).toBeUndefined()
  })

  it('keeps only deviations and drops unknown keys', () => {
    expect(deriveOverlay(config, {interval: 30, junk: 1, mqttUrl: 'mqtt://x'})).toEqual({
      interval: 30,
      mqttUrl: 'mqtt://x',
    })
  })

  it('prunes empty objects and arrays', () => {
    const schema = object({box: object({n: number({default: 1})}), tags: array(string())})
    expect(deriveOverlay(schema, {box: {}, tags: []})).toBeUndefined()
    expect(deriveOverlay(schema, {box: {n: 1}, tags: []})).toBeUndefined()
    expect(deriveOverlay(schema, {box: {n: 2}})).toEqual({box: {n: 2}})
  })

  it('strips arrays equal to their default, keeps deviating ones', () => {
    const schema = object({servers: array(string(), {default: ['pool.ntp.org']})})
    expect(deriveOverlay(schema, {servers: ['pool.ntp.org']})).toBeUndefined()
    expect(deriveOverlay(schema, {servers: ['a', 'b']})).toEqual({servers: ['a', 'b']})
  })

  it('treats wholesale values as units, empty containers inside survive', () => {
    const overlay = deriveOverlay(config, {net: {mode: 'dhcp'}})
    expect(overlay).toEqual({net: {mode: 'dhcp'}})
  })

  it('keeps optional leaf overrides verbatim', () => {
    expect(deriveOverlay(config, {label: 'bench 3'})).toEqual({label: 'bench 3'})
  })

  // Unknown keys ride inside wholesale units, but the prototype-writing
  // names never survive into a stored or served value.
  it('strips dangerous keys inside wholesale units', () => {
    const junk = JSON.parse('{"mode":"dhcp","__proto__":{"polluted":true},"extra":1}')
    const overlay = deriveOverlay(config, {net: junk}) as {net: Record<string, unknown>}
    expect(Object.keys(overlay.net).sort()).toEqual(['extra', 'mode'])
  })

  // Dropping a wrong-kind value would derive a clean overlay from garbage:
  // a typo'd save would report ok while storing nothing, and a container
  // kind changed between releases would never trip rule 5.
  it('keeps defined values of the wrong kind for validation to reject', () => {
    const schema = object({box: object({n: number({default: 1})}), tags: array(string())})
    expect(deriveOverlay(schema, {box: 42})).toEqual({box: 42})
    expect(deriveOverlay(schema, {tags: 'nope'})).toEqual({tags: 'nope'})
    expect(parseEffective(schema, deriveOverlay(schema, {box: 42})).ok).toBe(false)
    expect(parseEffective(schema, deriveOverlay(schema, {tags: 'nope'})).ok).toBe(false)
  })
})

describe('parseEffective', () => {
  it('validates the merged document', () => {
    const good = parseEffective(config, {mqttUrl: 'mqtt://x', net: {mode: 'dhcp'}})
    expect(good.ok).toBe(true)
    if (good.ok) {
      expect(good.value).toEqual({
        mqttUrl: 'mqtt://x',
        interval: 60,
        logLevel: 'info',
        tags: [],
        net: {mode: 'dhcp'},
      })
    }
  })

  it('reports missing required leaves', () => {
    const result = parseEffective(config, undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.path).toBe('.mqttUrl')
  })
})

describe('diffConfigSchemas', () => {
  const v1 = object({
    interval: number({default: 60}),
    apiKey: string({default: ''}),
    label: optional(string()),
    mode: union([literal('a'), literal('b')], {default: 'a'}),
  })

  it('is silent for safe changes', () => {
    const v2 = object({
      interval: number({default: 60}),
      apiKey: string({default: ''}),
      label: optional(string()),
      mode: union([literal('a'), literal('b')], {default: 'a'}),
      // new defaulted and optional fields, and a new array, are safe
      tags: array(string()),
      note: optional(string()),
      retries: number({default: 3}),
    })
    expect(diffConfigSchemas(v1, v2)).toEqual([])
  })

  it('flags what needs an operator', () => {
    const v2 = object({
      interval: string(), // type change
      apiKey: string(), // default removed: now required
      label: optional(string()),
      mode: union([literal('a'), literal('b')], {default: 'a'}),
      endpoint: string(), // new required field
    })
    const warnings = diffConfigSchemas(v1, v2)
    expect(warnings.filter((w) => w.startsWith('requires an operator'))).toHaveLength(3)
    expect(warnings.join('\n')).toContain('.interval changed type')
    expect(warnings.join('\n')).toContain('.apiKey is now required')
    expect(warnings.join('\n')).toContain('new required field .endpoint')
  })

  it('notes compatible but visible changes', () => {
    const v2 = object({
      interval: number({default: 30}), // default changed
      apiKey: string({default: ''}),
      mode: union([literal('a'), literal('b')], {default: 'a'}),
      // label removed
    })
    const warnings = diffConfigSchemas(v1, v2)
    expect(warnings.every((w) => w.startsWith('note:'))).toBe(true)
    expect(warnings.join('\n')).toContain('default of .interval changed')
    expect(warnings.join('\n')).toContain('removed field .label')
  })

  // Widening an enum is the most common safe evolution; only removals can
  // invalidate a stored override.
  it('treats added union members as safe and flags removed ones', () => {
    const widened = object({
      interval: number({default: 60}),
      apiKey: string({default: ''}),
      label: optional(string()),
      mode: union([literal('a'), literal('b'), literal('c')], {default: 'a'}),
    })
    expect(diffConfigSchemas(v1, widened)).toEqual([])

    const narrowed = object({
      interval: number({default: 60}),
      apiKey: string({default: ''}),
      label: optional(string()),
      mode: union([literal('a')], {default: 'a'}),
    })
    const warnings = diffConfigSchemas(v1, narrowed)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('.mode removed 1 union member')
  })

  it('treats added taggedUnion branches as safe and flags removed or reshaped ones', () => {
    const base = object({net: taggedUnion('mode', {dhcp: object({})})})
    const grown = object({
      net: taggedUnion('mode', {dhcp: object({}), static: object({ip: string()})}),
    })
    expect(diffConfigSchemas(base, grown)).toEqual([])

    const shrunk = diffConfigSchemas(grown, base)
    expect(shrunk).toHaveLength(1)
    expect(shrunk[0]).toContain('removed branch "static"')

    const reshaped = object({
      net: taggedUnion('mode', {dhcp: object({}), static: object({ip: number()})}),
    })
    const warnings = diffConfigSchemas(grown, reshaped)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('.net.static changed type')
  })

  it('reports required leaves inside an added object subtree', () => {
    const v2 = object({
      interval: number({default: 60}),
      apiKey: string({default: ''}),
      label: optional(string()),
      mode: union([literal('a'), literal('b')], {default: 'a'}),
      mqtt: object({host: string(), port: number({default: 1883})}),
    })
    const warnings = diffConfigSchemas(v1, v2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('new required field .mqtt.host')
  })
})

describe('structuralEquals', () => {
  it('compares deep structures', () => {
    expect(structuralEquals({a: [1, {b: 2}]}, {a: [1, {b: 2}]})).toBe(true)
    expect(structuralEquals({a: [1]}, {a: [1, 2]})).toBe(false)
    expect(structuralEquals(1, '1')).toBe(false)
    expect(structuralEquals(undefined, undefined)).toBe(true)
  })
})
