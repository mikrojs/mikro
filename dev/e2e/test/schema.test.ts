import {
  applyDefaults,
  array,
  boolean,
  enumOf,
  literal,
  number,
  object,
  optional,
  parse,
  string,
  taggedUnion,
  tuple,
  union,
  unknown,
} from 'mikro/schema'
import {assert, describe, test} from 'mikro/test'

describe('schema', () => {
  test('string validates strings', () => {
    assert.ok(parse(string(), 'hello'))
    assert.err(parse(string(), 42))
  })

  test('number validates numbers', () => {
    assert.ok(parse(number(), 42))
    assert.ok(parse(number(), 3.14))
    assert.err(parse(number(), 'nope'))
  })

  test('boolean validates booleans', () => {
    assert.ok(parse(boolean(), true))
    assert.ok(parse(boolean(), false))
    assert.err(parse(boolean(), 0))
  })

  test('unknown accepts anything', () => {
    assert.ok(parse(unknown(), 'a'))
    assert.ok(parse(unknown(), 42))
    assert.ok(parse(unknown(), null))
    assert.ok(parse(unknown(), undefined))
    assert.ok(parse(unknown(), {x: 1}))
  })

  test('literal validates exact values', () => {
    assert.ok(parse(literal('on'), 'on'))
    assert.err(parse(literal('on'), 'off'))
    assert.ok(parse(literal(42), 42))
    assert.err(parse(literal(42), 43))
  })

  test('array validates arrays', () => {
    const schema = array(number())
    const r = parse(schema, [1, 2, 3])
    assert.ok(r)
    assert.deepEqual(r.value, [1, 2, 3])
    assert.err(parse(schema, [1, 'two']))
    assert.err(parse(schema, 'not array'))
  })

  test('object validates shape', () => {
    const schema = object({name: string(), age: number()})
    const r = parse(schema, {name: 'Alice', age: 30})
    assert.ok(r)
    const v = r.value as any
    assert.equal(v.name, 'Alice')
    assert.equal(v.age, 30)
    assert.err(parse(schema, {name: 'Bob'}))
    assert.err(parse(schema, 'string'))
  })

  test('optional makes field optional', () => {
    const schema = object({name: string(), nick: optional(string())})
    assert.ok(parse(schema, {name: 'Alice'}))
    assert.ok(parse(schema, {name: 'Alice', nick: 'Ali'}))
    assert.err(parse(schema, {name: 'Alice', nick: 42}))
  })

  test('union matches any member', () => {
    const schema = union([string(), number()])
    assert.ok(parse(schema, 'hello'))
    assert.ok(parse(schema, 42))
    assert.err(parse(schema, true))
  })

  test('taggedUnion matches by discriminator', () => {
    const schema = taggedUnion('type', {
      circle: object({type: literal('circle'), radius: number()}),
      rect: object({type: literal('rect'), w: number(), h: number()}),
    })
    const r = parse(schema, {type: 'circle', radius: 5})
    assert.ok(r)
    const c = r.value as any
    assert.equal(c.type, 'circle')
    assert.equal(c.radius, 5)
    assert.err(parse(schema, {type: 'triangle'}))
  })

  test('nested object + array', () => {
    const schema = object({
      items: array(object({id: number(), label: string()})),
    })
    const r = parse(schema, {
      items: [
        {id: 1, label: 'a'},
        {id: 2, label: 'b'},
      ],
    })
    assert.ok(r)
    const v = r.value as any
    assert.equal(v.items.length, 2)
    assert.equal(v.items[0].id, 1)
  })

  /* Bounds run on the device too, which they did not when this module was
   * bytecode. The pin case is the one that mattered: an out-of-range GPIO
   * saved through config once crash-looped a board. */
  test('number bounds are enforced', () => {
    assert.ok(parse(number({min: 0, max: 30}), 30))
    assert.err(parse(number({min: 0, max: 30}), 200))
    assert.err(parse(number({min: 0, max: 30}), -1))
  })

  test('integer rejects a fraction', () => {
    assert.ok(parse(number({integer: true}), 4))
    assert.err(parse(number({integer: true}), 4.5))
  })

  test('string length bounds are enforced', () => {
    assert.ok(parse(string({minLength: 1, maxLength: 4}), 'ok'))
    assert.err(parse(string({minLength: 1, maxLength: 4}), ''))
    assert.err(parse(string({minLength: 1, maxLength: 4}), 'toolong'))
  })

  test('array item bounds are enforced', () => {
    assert.ok(parse(array(number(), {minItems: 1, maxItems: 2}), [1]))
    assert.err(parse(array(number(), {minItems: 1, maxItems: 2}), []))
    assert.err(parse(array(number(), {minItems: 1, maxItems: 2}), [1, 2, 3]))
  })

  test('a bound names the field it failed on', () => {
    const r = parse(object({pin: number({max: 30})}), {pin: 200})
    assert.err(r)
    assert.equal(r.error.message, 'above the maximum of 30')
    assert.equal(r.error.path, '.pin')
  })

  test('a union takes what any member allows', () => {
    const schema = union([number({max: 10}), number({min: 100})])
    assert.ok(parse(schema, 5))
    assert.ok(parse(schema, 150))
    assert.err(parse(schema, 50))
  })

  /* format needs regular expressions the device has no engine for, so it is
   * checked where config is written and nowhere else. */
  test('format is not checked here', () => {
    assert.ok(parse(string({format: 'ipv4'}), 'not-an-ip'))
  })

  /* tuple, enumOf and applyDefaults had no device coverage at all until the
   * DSL became native code. The exhaustive per-kind checks live in the
   * conformance corpus, which runs the same C++ on the host; what only a board
   * can show is these paths allocating under a real heap. */
  test('tuple validates position and length', () => {
    const schema = tuple([number(), string()])
    assert.ok(parse(schema, [1, 'a']))
    assert.err(parse(schema, [1]))
    assert.err(parse(schema, [1, 'a', 2]))
    assert.err(parse(schema, ['a', 'a']))
  })

  test('enumOf accepts its values and rejects others', () => {
    const schema = enumOf([{value: 'slow', title: 'Slow'}, {value: 'fast'}])
    assert.ok(parse(schema, 'slow'))
    assert.ok(parse(schema, 'fast'))
    assert.err(parse(schema, 'medium'))
  })

  test('applyDefaults fills and layers', () => {
    const schema = object({
      interval: number({default: 60}),
      name: string({default: 'box'}),
      tags: array(string()),
    })
    assert.deepEqual(applyDefaults(schema, undefined), {interval: 60, name: 'box', tags: []})
    assert.deepEqual(applyDefaults(schema, {interval: 5}), {
      interval: 5,
      name: 'box',
      tags: [],
    })
    // Unknown keys are dropped rather than carried through.
    assert.deepEqual(applyDefaults(schema, {nope: 1}), {interval: 60, name: 'box', tags: []})
  })

  /* QuickJS packs small integers as a different value tag from doubles, and
   * the bound check reads both through JS_ToFloat64. On a 32-bit target that
   * is a different path than the host takes for the same schema. */
  test('bounds hold for values beyond a 32-bit int', () => {
    const schema = number({min: 0, max: 3_000_000_000})
    assert.ok(parse(schema, 2_999_999_999))
    assert.err(parse(schema, 3_000_000_001))
  })

  /* The bound in the message is rendered by the engine's number formatting,
   * which is dtoa; this is where host and device would disagree if they did. */
  test('a fractional bound reads as written', () => {
    const r = parse(number({min: 0.5}), 0.25)
    assert.err(r)
    assert.equal(r.error.message, 'below the minimum of 0.5')
  })
})
