import {
  array,
  boolean,
  literal,
  number,
  object,
  optional,
  parse,
  string,
  taggedUnion,
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
})
