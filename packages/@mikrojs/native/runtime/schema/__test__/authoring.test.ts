import {describe, expect, it} from 'vitest'

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

/* The two-tier rule: plain objects compose defaults from their fields, while
 * arrays, tuples and taggedUnions take a whole-value default or none. A
 * default written below a unit never fills, so it is rejected where it is
 * written. */
describe('two-tier defaults', () => {
  it('rejects a leaf default under a taggedUnion branch', () => {
    expect(() =>
      taggedUnion('kind', {
        a: object({x: number({default: 1})}),
        b: object({}),
      }),
    ).toThrow(
      /a default under a taggedUnion never applies; give the union itself a whole-value default instead \(found at \.a\.x\)/,
    )
  })

  it('reports the path through nested objects and optional()', () => {
    expect(() =>
      taggedUnion('kind', {
        a: object({box: object({deep: object({x: string({default: 'y'})})})}),
      }),
    ).toThrow(/found at \.a\.box\.deep\.x/)
    expect(() =>
      taggedUnion('kind', {a: object({box: optional(object({x: boolean({default: true})}))})}),
    ).toThrow(/found at \.a\.box\.x/)
    // optional() already rejects an inner default, so the walk cannot reach one
    // and never reports the same node twice.
    expect(() => optional(string({default: 'x'}))).toThrow(/cannot wrap a schema with a default/)
  })

  it('rejects a nested unit that carries its own whole-value default', () => {
    expect(() =>
      taggedUnion('kind', {a: object({tags: array(string(), {default: ['x']})})}),
    ).toThrow(/a default under a taggedUnion never applies.*found at \.a\.tags/s)
    expect(() => array(taggedUnion('kind', {a: object({})}, {default: {kind: 'a'}}))).toThrow(
      /a default under an array never applies; give the array itself/,
    )
  })

  it('rejects a default under an array or a tuple, at its position', () => {
    expect(() => array(number({default: 1}))).toThrow(/found at \[\]/)
    expect(() => array(object({size: number({default: 1})}))).toThrow(/found at \[\]\.size/)
    expect(() => tuple([string(), number({default: 1})])).toThrow(
      /a default under a tuple never applies; give the tuple itself a whole-value default instead \(found at \[1\]\)/,
    )
  })

  it('keeps the unit-level whole-value default, which is the supported form', () => {
    expect(array(string(), {default: ['a']}).default).toEqual(['a'])
    expect(tuple([string(), number()], {default: ['a', 1]}).default).toEqual(['a', 1])
    const net = taggedUnion(
      'mode',
      {dhcp: object({}), static: object({ip: string()})},
      {default: {mode: 'dhcp'}},
    )
    expect(net.default).toEqual({mode: 'dhcp'})
  })

  it('leaves defaults inside plain objects alone', () => {
    const schema = object({
      host: string({default: 'mqtt.local'}),
      nested: object({port: number({default: 1883})}),
      pick: union([literal('a'), literal('b')], {default: 'a'}),
    })
    expect(schema.shape.host.default).toBe('mqtt.local')
  })

  it('rejects a member default inside a plain union, keeping the whole-value form', () => {
    // applyDefaults replaces a union wholesale like the tagged one, so a
    // default inside a member is the same silent no-op.
    expect(() => union([object({x: number({default: 1})}), object({})])).toThrow(
      /a default under a union never applies; give the union itself a whole-value default instead \(found at \[0\]\.x\)/,
    )
    expect(union([literal('a'), literal('b')], {default: 'b'}).default).toBe('b')
  })

  it('rejects a container default on a plain object', () => {
    expect(() => object({x: number()}, {default: {x: 1} as never})).toThrow(
      /an object's defaults compose from its fields; declare defaults on the fields/,
    )
  })
})
