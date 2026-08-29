import {describe, expect, it} from 'vitest'

import {
  deriveOverlay,
  diffConfigSchemas,
  materializeDefaults,
  parseConfigSchema,
  parseEffective,
  structuralEquals,
  UNITS,
  validateConfig,
} from '../config.js'
import {
  array,
  boolean,
  literal,
  number,
  object,
  optional,
  string,
  taggedUnion,
  tuple,
  union,
} from '../core.js'

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

  // The constructors reject these where they are written, so a schema can only
  // arrive in this shape as JSON: a hand-written wire schema, or one built by a
  // registry that never ran the constructors.
  it('rejects a default below a wholesale unit (hand-built AST)', () => {
    const underUnion = parseConfigSchema({
      kind: 'object',
      shape: {
        net: {
          kind: 'taggedUnion',
          key: 'mode',
          branches: {static: {kind: 'object', shape: {port: {kind: 'number', default: 80}}}},
        },
      },
    })
    expect(underUnion.ok).toBe(false)
    if (!underUnion.ok) {
      expect(underUnion.error.message).toContain('a default under a taggedUnion never applies')
      expect(underUnion.error.path).toBe('.net.static.port')
    }

    const underArray = parseConfigSchema({
      kind: 'object',
      shape: {tags: {kind: 'array', element: {kind: 'string', default: 'x'}}},
    })
    expect(underArray.ok).toBe(false)
    if (!underArray.ok) {
      expect(underArray.error.message).toContain('a default under an array never applies')
      expect(underArray.error.path).toBe('.tags.element')
    }

    const underTuple = parseConfigSchema({
      kind: 'object',
      shape: {
        pair: {
          kind: 'tuple',
          elements: [{kind: 'number'}, {kind: 'number', default: 1}],
        },
      },
    })
    expect(underTuple.ok).toBe(false)
    if (!underTuple.ok) {
      expect(underTuple.error.message).toContain('a default under a tuple never applies')
      expect(underTuple.error.path).toBe('.pair[1]')
    }
  })

  it('rejects a container default on a plain object (hand-built AST)', () => {
    const result = parseConfigSchema({
      kind: 'object',
      shape: {
        net: {kind: 'object', shape: {host: {kind: 'string'}}, default: {host: 'mqtt.local'}},
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('object() cannot carry a default')
      expect(result.error.path).toBe('.net')
    }
  })

  it('rejects a default inside a plain union member', () => {
    const underUnion = parseConfigSchema({
      kind: 'object',
      shape: {
        net: {
          kind: 'union',
          members: [
            {kind: 'object', shape: {x: {kind: 'number', default: 1}}},
            {kind: 'object', shape: {}},
          ],
        },
      },
    })
    expect(underUnion.ok).toBe(false)
    if (!underUnion.ok) {
      expect(underUnion.error.message).toContain('a default under a union never applies')
      expect(underUnion.error.path).toBe('.net[0].x')
    }
  })

  it('accepts a whole-value default on the unit itself', () => {
    const accepted = object({
      net: taggedUnion(
        'mode',
        {dhcp: object({}), static: object({ip: string()})},
        {default: {mode: 'static', ip: '10.0.0.2'}},
      ),
      tags: array(string(), {default: ['a']}),
    })
    const result = parseConfigSchema(JSON.parse(JSON.stringify(accepted)))
    expect(result.ok).toBe(true)
  })

  it('rejects nesting deeper than 8 levels', () => {
    let node: Record<string, unknown> = {kind: 'string'}
    for (let i = 0; i < 9; i++) node = {kind: 'object', shape: {n: node}}
    const result = parseConfigSchema(node)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('deeper than')
  })
})

describe('parseConfigSchema annotations', () => {
  const withNode = (node: unknown) => parseConfigSchema({kind: 'object', shape: {x: node}})
  const message = (result: ReturnType<typeof parseConfigSchema>) =>
    result.ok ? '' : result.error.message

  it('accepts title, description and mask', () => {
    const result = withNode({kind: 'string', title: 'Host', description: 'Broker host'})
    expect(result.ok).toBe(true)
    expect(withNode({kind: 'string', mask: true}).ok).toBe(true)
    expect(withNode({kind: 'number', mask: false}).ok).toBe(true)
  })

  it('rejects non-string, empty and oversized annotation text', () => {
    expect(message(withNode({kind: 'string', title: 7}))).toContain('title must be a string')
    expect(message(withNode({kind: 'string', title: ''}))).toContain('must not be empty')
    expect(message(withNode({kind: 'string', title: 'a'.repeat(81)}))).toContain('longer than 80')
    expect(message(withNode({kind: 'string', description: 'a'.repeat(501)}))).toContain(
      'longer than 500',
    )
  })

  it('rejects annotations on the optional() wrapper', () => {
    const result = parseConfigSchema({
      kind: 'object',
      shape: {x: {kind: 'optional', inner: {kind: 'string'}, title: 'Nope'}},
    })
    expect(message(result)).toContain('cannot carry a title')
  })

  it('rejects mask where it means nothing, and mask with a default', () => {
    expect(message(withNode({kind: 'boolean', mask: true}))).toContain(
      'only allowed on string() and number()',
    )
    expect(message(withNode({kind: 'string', mask: 'yes'}))).toContain('mask must be a boolean')
    expect(message(withNode({kind: 'string', mask: true, default: 'hunter2'}))).toContain(
      'masked field cannot carry a default',
    )
    // mask: false is the ordinary state and says nothing about defaults.
    expect(withNode({kind: 'string', mask: false, default: 'anything'}).ok).toBe(true)
  })
})

describe('parseConfigSchema constraints', () => {
  const withNode = (node: unknown) => parseConfigSchema({kind: 'object', shape: {x: node}})
  const message = (result: ReturnType<typeof parseConfigSchema>) =>
    result.ok ? '' : result.error.message

  it('accepts constraints on the kind that has them', () => {
    expect(withNode({kind: 'number', min: 0, max: 30, integer: true}).ok).toBe(true)
    expect(withNode({kind: 'string', minLength: 1, maxLength: 8}).ok).toBe(true)
    expect(withNode({kind: 'array', element: {kind: 'string'}, maxItems: 4}).ok).toBe(true)
  })

  it('rejects a constraint on a kind that has no such thing', () => {
    expect(message(withNode({kind: 'string', min: 1}))).toContain('min is not allowed on string()')
    expect(message(withNode({kind: 'number', maxLength: 1}))).toContain('not allowed on number()')
    expect(message(withNode({kind: 'boolean', integer: true}))).toContain(
      'integer is not allowed on boolean()',
    )
  })

  it('rejects malformed constraint values', () => {
    expect(message(withNode({kind: 'number', min: 'x'}))).toContain('must be a finite number')
    expect(message(withNode({kind: 'string', maxLength: -1}))).toContain(
      'non-negative whole number',
    )
    expect(message(withNode({kind: 'string', maxLength: 1.5}))).toContain(
      'non-negative whole number',
    )
    expect(message(withNode({kind: 'number', integer: 'yes'}))).toContain(
      'integer must be a boolean',
    )
  })

  it('rejects a default outside its own bounds, which the constructor no longer can', () => {
    // core.ts dropped the constraint checks, so this is the check that catches
    // it, and it runs when the config is packed.
    const message = (node: unknown) => {
      const result = parseConfigSchema({kind: 'object', shape: {x: node}})
      return result.ok ? '' : result.error.message
    }
    expect(message({kind: 'number', max: 30, default: 200})).toContain('above the maximum of 30')
    expect(message({kind: 'number', integer: true, default: 1.5})).toContain('whole number')
    expect(message({kind: 'string', minLength: 1, default: ''})).toContain('shorter than 1')
    expect(message({kind: 'string', format: 'ipv4', default: 'nope'})).toContain('not a valid ipv4')
  })

  it('rejects an inverted range and a default outside its bounds', () => {
    expect(message(withNode({kind: 'number', min: 10, max: 5}))).toContain(
      'min is greater than max',
    )
    expect(message(withNode({kind: 'number', max: 30, default: 200}))).toContain(
      'above the maximum of 30',
    )
  })
})

describe('parseConfigSchema format', () => {
  const withNode = (node: unknown) => parseConfigSchema({kind: 'object', shape: {x: node}})
  const message = (result: ReturnType<typeof parseConfigSchema>) =>
    result.ok ? '' : result.error.message

  it('accepts every known format', () => {
    for (const format of ['url', 'hostname', 'ipv4', 'mac', 'email']) {
      expect(withNode({kind: 'string', format}).ok).toBe(true)
    }
  })

  it('fails closed on an unknown format rather than ignoring it', () => {
    const result = withNode({kind: 'string', format: 'ipv6'})
    expect(result.ok).toBe(false)
    expect(message(result)).toContain('unknown format "ipv6"')
    expect(message(result)).toContain('known: url, hostname, ipv4, mac, email')
  })

  it('rejects format on a kind that has no string to check', () => {
    expect(message(withNode({kind: 'number', format: 'url'}))).toContain(
      'format is not allowed on number()',
    )
  })
})

describe('the unit table', () => {
  it('has an ASCII key for every entry, which is what keeps identity stable', () => {
    // The keys are hashed into the config rev and compared with structuralEquals.
    // A non-ASCII key would be rewritten by any NFKC pass (micro sign decomposes
    // to Greek mu, superscript two to a digit) and an unchanged republish would
    // 409 with nothing to show for it.
    for (const key of Object.keys(UNITS)) {
      expect(key).toMatch(/^[\x20-\x7e]+$/)
    }
  })

  it('resolves every secondary unit to a primary that is itself in the table', () => {
    for (const [key, def] of Object.entries(UNITS)) {
      expect(UNITS[def.primary], `${key} derives from ${def.primary}`).toBeDefined()
      expect(UNITS[def.primary]!.primary).toBe(def.primary)
      if (def.primary === key) expect(def.scale).toBe(1)
    }
  })

  it('carries the SenML derivations the registry states', () => {
    expect(UNITS.ms).toMatchObject({primary: 's', scale: 1 / 1000, offset: 0})
    expect(UNITS.h).toMatchObject({primary: 's', scale: 3600})
    expect(UNITS.KiB).toMatchObject({primary: 'B', scale: 1024})
    // dBm is the reason the table carries an offset at all.
    expect(UNITS.dBm).toMatchObject({primary: 'dBW', scale: 1, offset: -30})
    // mAh chains to the primary C, not to the secondary Ah.
    expect(UNITS.mAh).toMatchObject({primary: 'C', scale: 3.6})
    expect(UNITS['KiB/s']).toMatchObject({primary: 'bit/s', scale: 8192})
  })

  it('renders a symbol where the ASCII key is not what a person reads', () => {
    expect(UNITS.Cel.symbol).toBe('\u00b0C')
    expect(UNITS.us.symbol).toBe('\u00b5s')
    expect(UNITS.Ohm.symbol).toBe('\u03a9')
    // SenML's `%` means a 0-1 ratio, not a percentage, so it is excluded and a
    // 0-100 field uses `/100`, which renders as `%`.
    expect(UNITS['/100'].symbol).toBe('%')
    expect(Object.hasOwn(UNITS, '%')).toBe(false)
    // The dimensionless units are named `/` and `count`; an empty symbol means
    // render the number with no suffix, since "0.8 /" says nothing.
    expect(UNITS['/'].symbol).toBe('')
    expect(UNITS.count.symbol).toBe('')
  })

  it('omits a bare `d`, which is the SI deci- prefix', () => {
    expect(Object.hasOwn(UNITS, 'd')).toBe(false)
    expect(Object.hasOwn(UNITS, 'h')).toBe(true)
  })
})

describe('parseConfigSchema unit', () => {
  const withNode = (node: unknown) => parseConfigSchema({kind: 'object', shape: {x: node}})
  const message = (result: ReturnType<typeof parseConfigSchema>) =>
    result.ok ? '' : result.error.message

  it('accepts a known unit on a number', () => {
    expect(withNode({kind: 'number', unit: 'ms'}).ok).toBe(true)
    expect(withNode({kind: 'number', unit: 'Cel'}).ok).toBe(true)
  })

  it('fails closed on an unknown unit and on the wrong kind', () => {
    expect(message(withNode({kind: 'number', unit: 'furlong'}))).toContain('unknown unit')
    expect(message(withNode({kind: 'number', unit: '%'}))).toContain('unknown unit')
    expect(message(withNode({kind: 'string', unit: 'ms'}))).toContain(
      'unit is not allowed on string()',
    )
  })
})

describe('validateConfig', () => {
  const check = (schema: Parameters<typeof validateConfig>[0], value: unknown) =>
    validateConfig(schema, value)
  const why = (schema: Parameters<typeof validateConfig>[0], value: unknown) => {
    const result = validateConfig(schema, value)
    return result.ok ? '' : result.error.message
  }

  it('bounds a number by min, max and integer', () => {
    const pin = number({min: 0, max: 30, integer: true})
    expect(check(pin, 15).ok).toBe(true)
    expect(check(pin, 200).ok).toBe(false)
    expect(check(pin, -1).ok).toBe(false)
    expect(check(pin, 1.5).ok).toBe(false)
    expect(why(number({min: 5, max: 10}), 200)).toBe('above the maximum of 10')
    expect(why(number({min: 5}), 1)).toBe('below the minimum of 5')
    expect(why(number({integer: true}), 1.5)).toBe('expected a whole number, got 1.5')
  })

  it('bounds a string by length and shape', () => {
    const ssid = string({minLength: 1, maxLength: 4})
    expect(check(ssid, 'home').ok).toBe(true)
    expect(check(ssid, '').ok).toBe(false)
    expect(check(ssid, 'toolong').ok).toBe(false)
    expect(why(string({format: 'ipv4'}), 'nope')).toBe('not a valid ipv4')
  })

  it('accepts any url scheme, and checks the other formats', () => {
    expect(check(string({format: 'url'}), 'mqtt://broker.local:1883').ok).toBe(true)
    expect(check(string({format: 'url'}), 'ws://10.0.0.1/socket').ok).toBe(true)
    expect(check(string({format: 'url'}), 'example.com').ok).toBe(false)
    expect(check(string({format: 'hostname'}), 'broker.local').ok).toBe(true)
    expect(check(string({format: 'hostname'}), '-bad.local').ok).toBe(false)
    expect(check(string({format: 'ipv4'}), '192.168.1.10').ok).toBe(true)
    expect(check(string({format: 'ipv4'}), '256.1.1.1').ok).toBe(false)
    expect(check(string({format: 'mac'}), 'a4:cf:12:9b:00:01').ok).toBe(true)
    expect(check(string({format: 'mac'}), 'a4:cf:12:9b:00').ok).toBe(false)
    expect(check(string({format: 'email'}), 'ops@example.com').ok).toBe(true)
    expect(check(string({format: 'email'}), 'nope@nodot').ok).toBe(false)
  })

  it('bounds an array and reaches constraints nested inside containers', () => {
    expect(check(array(string(), {minItems: 1, maxItems: 2}), ['a']).ok).toBe(true)
    expect(check(array(string(), {minItems: 1}), []).ok).toBe(false)
    expect(check(array(number({max: 10})), [1, 99]).ok).toBe(false)
    expect(why(object({a: object({b: number({max: 1})})}), {a: {b: 9}})).toBe(
      'above the maximum of 1',
    )
    expect(check(optional(number({max: 1})), undefined).ok).toBe(true)
    expect(check(optional(number({max: 1})), 9).ok).toBe(false)
  })

  it('reports the path of the field that broke its bound', () => {
    const result = validateConfig(object({pwm: object({duty: number({max: 1})})}), {
      pwm: {duty: 5},
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.path).toBe('.pwm.duty')
  })

  it('accepts a value any union member allows, not just the first that fits', () => {
    // Structural validation accepts what any member accepts, so the constraint
    // pass has to agree. 150 matches the first member's shape and breaks its
    // bound, but the second member exists for exactly that value.
    const schema = union([number({min: 0, max: 10}), number({min: 100, max: 200})])
    expect(check(schema, 5).ok).toBe(true)
    expect(check(schema, 150).ok).toBe(true)
    expect(check(schema, 50).ok).toBe(false)
    // With one member, the specific bound message survives.
    expect(why(union([number({max: 10})]), 50)).toBe('above the maximum of 10')
  })

  it('still fails on structure, and leaves unconstrained nodes alone', () => {
    expect(check(number({min: 0}), 'x').ok).toBe(false)
    expect(check(number(), -1e9).ok).toBe(true)
    expect(check(string(), '').ok).toBe(true)
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

  it('gates on a tightened bound and stays silent on a loosened one', () => {
    const before = object({interval: number({default: 60, min: 0, max: 3600})})
    const tighter = object({interval: number({default: 60, min: 30, max: 300})})
    const warnings = diffConfigSchemas(before, tighter)
    expect(warnings).toEqual([
      'requires an operator: .interval raised min (stored overrides may no longer validate)',
      'requires an operator: .interval lowered max (stored overrides may no longer validate)',
    ])
    expect(diffConfigSchemas(tighter, before)).toEqual([])
  })

  it('gates on a newly added bound and on a new whole-number requirement', () => {
    const before = object({pin: number({default: 8})})
    expect(diffConfigSchemas(before, object({pin: number({default: 8, max: 30})}))).toEqual([
      'requires an operator: .pin added max (stored overrides may no longer validate)',
    ])
    expect(diffConfigSchemas(before, object({pin: number({default: 8, integer: true})}))).toEqual([
      'requires an operator: .pin now requires a whole number ' +
        '(stored overrides may no longer validate)',
    ])
  })

  it('does not mistake a constraint change for a changed type', () => {
    const before = object({name: string({default: 'a'})})
    const after = object({name: string({default: 'a', maxLength: 8})})
    expect(diffConfigSchemas(before, after).join(' ')).not.toContain('changed type')
  })

  it('gates on a new or changed format, and reports it as a format change', () => {
    const before = object({broker: string({default: 'mqtt://localhost'})})
    const added = object({broker: string({default: 'mqtt://localhost', format: 'url'})})
    expect(diffConfigSchemas(before, added)).toEqual([
      'requires an operator: .broker now requires format "url" ' +
        '(stored overrides may no longer validate)',
    ])
    // Dropping a format only widens what validates.
    expect(diffConfigSchemas(added, before)).toEqual([])
    // And it must not read as a changed type, which would also return early.
    expect(diffConfigSchemas(before, added).join(' ')).not.toContain('changed type')
  })

  it('gates on a bound tightened inside an array element or a tuple position', () => {
    // The walk recurses through object shapes only, so without an explicit
    // descent a stranded override here would carry no operator gate at all.
    const beforeArray = object({levels: array(number({max: 10}))})
    const afterArray = object({levels: array(number({max: 5}))})
    expect(diffConfigSchemas(beforeArray, afterArray)).toEqual([
      'requires an operator: .levels[] lowered max (stored overrides may no longer validate)',
    ])

    const beforeTuple = object({range: tuple([number(), number({max: 100})])})
    const afterTuple = object({range: tuple([number(), number({max: 10})])})
    expect(diffConfigSchemas(beforeTuple, afterTuple)).toEqual([
      'requires an operator: .range[1] lowered max (stored overrides may no longer validate)',
    ])

    // Loosening inside an element stays silent, like everywhere else.
    expect(diffConfigSchemas(afterArray, beforeArray)).toEqual([])
  })

  it('reaches a bound tightened on an object nested inside a container', () => {
    // array-of-objects is an ordinary config shape, and the stranded-override
    // scenario is the same as for a bare element with one more level of nesting.
    const before = object({peers: array(object({port: number({max: 65535})}))})
    const after = object({peers: array(object({port: number({max: 1024})}))})
    expect(diffConfigSchemas(before, after)).toEqual([
      'requires an operator: .peers[].port lowered max (stored overrides may no longer validate)',
    ])
    expect(diffConfigSchemas(after, before)).toEqual([])
  })

  it('reaches a bound tightened inside a taggedUnion branch, and does not call it a type change', () => {
    const before = object({
      net: taggedUnion('mode', {
        dhcp: object({retries: number({max: 10})}),
        static: object({host: string()}),
      }),
    })
    const after = object({
      net: taggedUnion('mode', {
        dhcp: object({retries: number({max: 3})}),
        static: object({host: string()}),
      }),
    })
    const warnings = diffConfigSchemas(before, after)
    expect(warnings).toEqual([
      'requires an operator: .net.dhcp.retries lowered max ' +
        '(stored overrides may no longer validate)',
    ])
    expect(warnings.join(' ')).not.toContain('changed type')
  })

  it('reports a nested object field once, not once per level', () => {
    const before = object({mqtt: object({port: number({max: 65535})})})
    const after = object({mqtt: object({port: number({max: 1024})})})
    expect(diffConfigSchemas(before, after)).toEqual([
      'requires an operator: .mqtt.port lowered max (stored overrides may no longer validate)',
    ])
  })

  it('gates when one of two same-shaped members goes, which membership alone misses', () => {
    // Both members strip to {kind: 'number'}, so asking whether a member of
    // that shape survives answers yes even though the 100-200 range has gone
    // and any override in it is now stranded.
    const before = object({level: union([number({min: 0, max: 10}), number({min: 100, max: 200})])})
    const after = object({level: union([number({min: 0, max: 10})])})
    expect(diffConfigSchemas(before, after)).toEqual([
      'requires an operator: .level removed 1 union member(s) ' +
        '(stored overrides using them no longer validate)',
    ])
    // Adding one back is a widening, and stays silent.
    expect(diffConfigSchemas(after, before)).toEqual([])
  })

  it('still gates on a removed member of a distinct shape', () => {
    const before = object({level: union([number(), string()])})
    const after = object({level: union([number()])})
    expect(diffConfigSchemas(before, after)).toEqual([
      'requires an operator: .level removed 1 union member(s) ' +
        '(stored overrides using them no longer validate)',
    ])
  })

  it('does not read a loosened bound in a union member as a removed member', () => {
    const before = object({level: union([number({max: 10}), string()])})
    const after = object({level: union([number({max: 100}), string()])})
    expect(diffConfigSchemas(before, after)).toEqual([])
    // Tightening the same member still gates.
    expect(diffConfigSchemas(after, before)).toEqual([
      'requires an operator: .level|0 lowered max (stored overrides may no longer validate)',
    ])
  })

  it('gates on a changed unit, which silently reinterprets stored values', () => {
    const before = object({interval: number({default: 60, unit: 's'})})
    const after = object({interval: number({default: 60, unit: 'ms'})})
    expect(diffConfigSchemas(before, after)).toEqual([
      'requires an operator: .interval changed unit from "s" to "ms" ' +
        '(stored values are reinterpreted)',
    ])
    expect(diffConfigSchemas(before, after).join(' ')).not.toContain('changed type')
  })

  it('is silent when only display annotations change', () => {
    const relabelled = object({
      interval: number({default: 60, title: 'Poll interval', description: 'How often'}),
      apiKey: string({default: '', title: 'API key', mask: true}),
      label: optional(string()),
      mode: union([literal('a'), literal('b')], {default: 'a', title: 'Mode'}),
    })
    expect(diffConfigSchemas(v1, relabelled)).toEqual([])
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

describe('materializeDefaults', () => {
  it('fills every field a default covers', () => {
    const schema = object({
      interval: number({default: 60}),
      url: string({default: 'mqtt://localhost'}),
      on: boolean({default: true}),
    })
    expect(materializeDefaults(schema)).toEqual({
      interval: 60,
      url: 'mqtt://localhost',
      on: true,
    })
  })

  it('omits defaultless leaves and optional fields', () => {
    const schema = object({
      interval: number({default: 60}),
      apiKey: string(),
      mqttUrl: string(),
      label: optional(string()),
    })
    expect(materializeDefaults(schema)).toEqual({interval: 60})
  })

  it('includes a nested object only when defaults fill it completely', () => {
    const schema = object({
      full: object({host: string({default: 'h'}), port: number({default: 1883})}),
      partial: object({host: string({default: 'h'}), port: number()}),
    })
    expect(materializeDefaults(schema)).toEqual({full: {host: 'h', port: 1883}})
  })

  it('counts an optional field as covered when deciding a nested object', () => {
    const schema = object({
      net: object({host: string({default: 'h'}), label: optional(string())}),
    })
    expect(materializeDefaults(schema)).toEqual({net: {host: 'h'}})
  })

  it('includes a wholesale unit only with a whole-value default', () => {
    const schema = object({
      tags: array(string(), {default: ['a']}),
      hosts: array(string()),
      mode: taggedUnion(
        'kind',
        {dhcp: object({}), static: object({ip: string()})},
        {default: {kind: 'dhcp'}},
      ),
      other: taggedUnion('kind', {dhcp: object({})}),
      level: union([literal('debug'), literal('info')], {default: 'info'}),
      bare: union([literal('debug'), literal('info')]),
    })
    expect(materializeDefaults(schema)).toEqual({
      tags: ['a'],
      mode: {kind: 'dhcp'},
      level: 'info',
    })
  })

  it('returns an empty object for a schema no default covers', () => {
    expect(materializeDefaults(object({mqttUrl: string(), port: number()}))).toEqual({})
    expect(materializeDefaults(object({}))).toEqual({})
  })
})
