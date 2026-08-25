import {describe, expect, it} from 'vitest'

import {
  applyDefaults,
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
} from '../schema.js'

describe('schema', () => {
  describe('string', () => {
    it('accepts strings', () => {
      const result = parse(string(), 'hello')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBe('hello')
    })

    it('rejects non-strings', () => {
      const result = parse(string(), 42)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('expected string, got number')
        expect(result.error.path).toBe('')
      }
    })
  })

  describe('number', () => {
    it('accepts numbers', () => {
      const result = parse(number(), 42)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBe(42)
    })

    it('rejects non-numbers', () => {
      const result = parse(number(), 'hello')
      expect(result.ok).toBe(false)
    })
  })

  describe('boolean', () => {
    it('accepts booleans', () => {
      expect(parse(boolean(), true).ok).toBe(true)
      expect(parse(boolean(), false).ok).toBe(true)
    })

    it('rejects non-booleans', () => {
      expect(parse(boolean(), 0).ok).toBe(false)
      expect(parse(boolean(), 'true').ok).toBe(false)
    })
  })

  describe('unknown', () => {
    it('accepts any value', () => {
      expect(parse(unknown(), 'hello').ok).toBe(true)
      expect(parse(unknown(), 42).ok).toBe(true)
      expect(parse(unknown(), true).ok).toBe(true)
      expect(parse(unknown(), null).ok).toBe(true)
      expect(parse(unknown(), undefined).ok).toBe(true)
      expect(parse(unknown(), [1, 2]).ok).toBe(true)
      expect(parse(unknown(), {a: 1}).ok).toBe(true)
    })

    it('works as object field', () => {
      const schema = object({type: literal('data'), payload: unknown()})
      const result = parse(schema, {type: 'data', payload: [1, 'mixed', null]})
      expect(result.ok).toBe(true)
    })
  })

  describe('literal', () => {
    it('accepts matching string literal', () => {
      const result = parse(literal('hello'), 'hello')
      expect(result.ok).toBe(true)
    })

    it('rejects non-matching string literal', () => {
      const result = parse(literal('hello'), 'world')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('expected "hello", got "world"')
      }
    })

    it('accepts matching number literal', () => {
      expect(parse(literal(42), 42).ok).toBe(true)
    })

    it('rejects non-matching number literal', () => {
      expect(parse(literal(42), 43).ok).toBe(false)
    })

    it('accepts matching boolean literal', () => {
      expect(parse(literal(true), true).ok).toBe(true)
      expect(parse(literal(false), false).ok).toBe(true)
    })

    it('rejects non-matching boolean literal', () => {
      expect(parse(literal(true), false).ok).toBe(false)
    })

    it('uses strict equality', () => {
      expect(parse(literal(0), false).ok).toBe(false)
      expect(parse(literal(''), false).ok).toBe(false)
    })
  })

  describe('array', () => {
    it('accepts matching arrays', () => {
      const result = parse(array(number()), [1, 2, 3])
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toEqual([1, 2, 3])
    })

    it('accepts empty arrays', () => {
      expect(parse(array(string()), []).ok).toBe(true)
    })

    it('rejects non-arrays', () => {
      const result = parse(array(number()), 'not an array')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('expected array, got string')
      }
    })

    it('rejects arrays with wrong element types', () => {
      const result = parse(array(number()), [1, 'two', 3])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('expected number, got string')
        expect(result.error.path).toBe('[1]')
      }
    })

    it('reports nested paths', () => {
      const result = parse(array(array(number())), [[1], [2, 'x']])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.path).toBe('[1][1]')
      }
    })
  })

  describe('object', () => {
    it('accepts matching objects', () => {
      const schema = object({name: string(), age: number()})
      const result = parse(schema, {name: 'Alice', age: 30})
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.name).toBe('Alice')
        expect(result.value.age).toBe(30)
      }
    })

    it('accepts objects with extra keys', () => {
      const schema = object({name: string()})
      const result = parse(schema, {name: 'Alice', extra: true})
      expect(result.ok).toBe(true)
    })

    it('rejects non-objects', () => {
      expect(parse(object({}), null).ok).toBe(false)
      expect(parse(object({}), 'string').ok).toBe(false)
      expect(parse(object({}), []).ok).toBe(false)
    })

    it('rejects objects with missing required fields', () => {
      const schema = object({name: string(), age: number()})
      const result = parse(schema, {name: 'Alice'})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('missing required field')
        expect(result.error.path).toBe('.age')
      }
    })

    it('rejects objects with wrong field types', () => {
      const schema = object({name: string()})
      const result = parse(schema, {name: 42})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('expected string, got number')
        expect(result.error.path).toBe('.name')
      }
    })

    it('reports nested paths', () => {
      const schema = object({inner: object({value: number()})})
      const result = parse(schema, {inner: {value: 'wrong'}})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.path).toBe('.inner.value')
      }
    })
  })

  describe('optional', () => {
    it('accepts missing optional fields', () => {
      const schema = object({name: string(), label: optional(string())})
      const result = parse(schema, {name: 'Alice'})
      expect(result.ok).toBe(true)
    })

    it('accepts present optional fields with correct type', () => {
      const schema = object({label: optional(string())})
      const result = parse(schema, {label: 'test'})
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.label).toBe('test')
    })

    it('rejects present optional fields with wrong type', () => {
      const schema = object({label: optional(string())})
      const result = parse(schema, {label: 42})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('expected string, got number')
        expect(result.error.path).toBe('.label')
      }
    })

    it('accepts undefined value for present key (matches TS `?:` semantics)', () => {
      const schema = object({label: optional(string())})
      const result = parse(schema, {label: undefined})
      expect(result.ok).toBe(true)
    })
  })

  describe('union', () => {
    it('accepts value matching first member', () => {
      const schema = union([string(), number()])
      expect(parse(schema, 'hello').ok).toBe(true)
    })

    it('accepts value matching second member', () => {
      const schema = union([string(), number()])
      expect(parse(schema, 42).ok).toBe(true)
    })

    it('rejects value matching no member', () => {
      const schema = union([string(), number()])
      const result = parse(schema, true)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('value did not match any union member')
      }
    })

    it('works with complex members', () => {
      const schema = union([object({type: literal('a')}), object({type: literal('b')})])
      expect(parse(schema, {type: 'a'}).ok).toBe(true)
      expect(parse(schema, {type: 'b'}).ok).toBe(true)
      expect(parse(schema, {type: 'c'}).ok).toBe(false)
    })
  })

  describe('taggedUnion', () => {
    const schema = taggedUnion('type', {
      error: object({message: string()}),
      success: object({value: number()}),
    })

    it('accepts matching tagged objects', () => {
      const r1 = parse(schema, {type: 'error', message: 'fail'})
      expect(r1.ok).toBe(true)

      const r2 = parse(schema, {type: 'success', value: 42})
      expect(r2.ok).toBe(true)
    })

    it('rejects unknown tags', () => {
      const result = parse(schema, {type: 'unknown'})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('unknown tag "unknown"')
        expect(result.error.path).toBe('.type')
      }
    })

    it('rejects a tag that only exists on the branches prototype', () => {
      const result = parse(schema, {type: 'constructor'})
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toBe('unknown tag "constructor"')
    })

    it('rejects missing discriminator', () => {
      const result = parse(schema, {message: 'no type'})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('missing discriminator field')
        expect(result.error.path).toBe('.type')
      }
    })

    it('rejects non-object values', () => {
      const result = parse(schema, 'not an object')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('expected object, got string')
      }
    })

    it('validates branch fields', () => {
      const result = parse(schema, {type: 'error', message: 42})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('expected string, got number')
        expect(result.error.path).toBe('.message')
      }
    })

    it('rejects missing required branch fields', () => {
      const result = parse(schema, {type: 'success'})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toBe('missing required field')
        expect(result.error.path).toBe('.value')
      }
    })
  })

  describe('nested schemas', () => {
    it('validates deeply nested structures', () => {
      const schema = object({
        items: array(
          object({
            name: string(),
            tags: array(string()),
          }),
        ),
      })

      expect(parse(schema, {items: [{name: 'a', tags: ['x', 'y']}]}).ok).toBe(true)

      const result = parse(schema, {items: [{name: 'a', tags: ['x', 3]}]})
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.path).toBe('.items[0].tags[1]')
      }
    })
  })

  describe('annotations', () => {
    it('stores default as a node property', () => {
      expect(string({default: 'foo'})).toEqual({kind: 'string', default: 'foo'})
      expect(number({default: 60})).toEqual({kind: 'number', default: 60})
      // cast: vitest's deep matcher type recurses forever into the Schema union
      expect(array(string(), {default: ['a']}) as unknown).toEqual({
        kind: 'array',
        element: {kind: 'string'},
        default: ['a'],
      })
    })

    it('serializes to JSON as-is', () => {
      const schema = object({interval: number({default: 60}), key: string()})
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
    })

    it('rejects a default that does not match the node', () => {
      expect(() => number({default: 'x' as never})).toThrow(TypeError)
      expect(() => array(string(), {default: [1] as never})).toThrow(TypeError)
      expect(() => union([literal('a'), literal('b')], {default: 'c' as never})).toThrow(TypeError)
    })

    it('rejects optional() around a default', () => {
      expect(() => optional(string({default: 'x'}))).toThrow(TypeError)
    })
  })

  describe('applyDefaults', () => {
    it('materializes objects from leaf defaults', () => {
      const schema = object({
        mqtt: object({host: string({default: 'mqtt.local'}), port: number({default: 1883})}),
      })
      expect(applyDefaults(schema, undefined)).toEqual({
        mqtt: {host: 'mqtt.local', port: 1883},
      })
    })

    it('layers an overlay over defaults and drops unknown keys', () => {
      const schema = object({host: string({default: 'a'}), port: number({default: 1})})
      expect(applyDefaults(schema, {port: 9, junk: true})).toEqual({host: 'a', port: 9})
    })

    it('materializes absent arrays as their default or empty', () => {
      expect(applyDefaults(object({tags: array(string())}), {})).toEqual({tags: []})
      expect(applyDefaults(object({tags: array(string(), {default: ['x']})}), {})).toEqual({
        tags: ['x'],
      })
      expect(
        applyDefaults(object({tags: array(string(), {default: ['x']})}), {tags: ['y']}),
      ).toEqual({tags: ['y']})
    })

    it('replaces wholesale nodes without filling inside them', () => {
      const schema = object({
        items: array(object({name: string(), size: number()}), {default: [{name: 'a', size: 1}]}),
      })
      // a present array is taken verbatim: the whole-value default is replaced,
      // never merged into the elements
      expect(applyDefaults(schema, {items: [{name: 'a'}]})).toEqual({items: [{name: 'a'}]})
      const parsed = parse(schema, applyDefaults(schema, {items: [{name: 'a'}]}))
      expect(parsed.ok).toBe(false)
    })

    // Replacing it with {} would make `{mqtt: 42}` validate clean against
    // pure defaults and never record a configError.
    it('keeps a present non-object at an object position for parse to reject', () => {
      const schema = object({mqtt: object({host: string({default: 'a'})})})
      expect(applyDefaults(schema, {mqtt: 42})).toEqual({mqtt: 42})
      expect(parse(schema, applyDefaults(schema, {mqtt: 42})).ok).toBe(false)
      expect(parse(schema, applyDefaults(schema, 42)).ok).toBe(false)
    })

    it('leaves required fields missing for parse to report', () => {
      const schema = object({key: string(), interval: number({default: 60})})
      const effective = applyDefaults(schema, undefined)
      expect(effective).toEqual({interval: 60})
      const result = parse(schema, effective)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.path).toBe('.key')
    })

    it('keeps optional fields absent unless present', () => {
      const schema = object({label: optional(string())})
      expect(applyDefaults(schema, undefined)).toEqual({})
      expect(applyDefaults(schema, {label: 'x'})).toEqual({label: 'x'})
    })
  })
})
