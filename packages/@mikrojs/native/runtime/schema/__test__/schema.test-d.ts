import {assertType, describe, it} from 'vitest'

import {
  array,
  boolean,
  type Infer,
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

describe('schema type inference', () => {
  it('infers string', () => {
    const result = parse(string(), null as unknown)
    if (result.ok) assertType<string>(result.value)
  })

  it('infers number', () => {
    const result = parse(number(), null as unknown)
    if (result.ok) assertType<number>(result.value)
  })

  it('infers boolean', () => {
    const result = parse(boolean(), null as unknown)
    if (result.ok) assertType<boolean>(result.value)
  })

  it('infers unknown', () => {
    const result = parse(unknown(), null as unknown)
    if (result.ok) assertType<unknown>(result.value)
  })

  it('infers unknown in object field', () => {
    const schema = object({type: string(), data: unknown()})
    const result = parse(schema, null as unknown)
    if (result.ok) {
      assertType<string>(result.value.type)
      assertType<unknown>(result.value.data)
    }
  })

  it('infers string literal', () => {
    const result = parse(literal('hello'), null as unknown)
    if (result.ok) assertType<'hello'>(result.value)
  })

  it('infers number literal', () => {
    const result = parse(literal(42), null as unknown)
    if (result.ok) assertType<42>(result.value)
  })

  it('infers boolean literal', () => {
    const result = parse(literal(true), null as unknown)
    if (result.ok) assertType<true>(result.value)
  })

  it('infers array of strings', () => {
    const result = parse(array(string()), null as unknown)
    if (result.ok) assertType<string[]>(result.value)
  })

  it('infers array of objects', () => {
    const schema = array(object({name: string()}))
    const result = parse(schema, null as unknown)
    if (result.ok) assertType<{name: string}[]>(result.value)
  })

  it('infers flat object', () => {
    const schema = object({name: string(), age: number()})
    const result = parse(schema, null as unknown)
    if (result.ok) {
      assertType<string>(result.value.name)
      assertType<number>(result.value.age)
    }
  })

  it('infers object with optional fields', () => {
    const schema = object({name: string(), label: optional(string())})
    const result = parse(schema, null as unknown)
    if (result.ok) {
      assertType<string>(result.value.name)
      assertType<string | undefined>(result.value.label)
    }
  })

  it('infers union', () => {
    const schema = union([string(), number()])
    const result = parse(schema, null as unknown)
    if (result.ok) assertType<string | number>(result.value)
  })

  it('infers tagged union', () => {
    const schema = taggedUnion('type', {
      error: object({message: string()}),
      success: object({value: number()}),
    })
    const result = parse(schema, null as unknown)
    if (result.ok) {
      if (result.value.type === 'error') {
        assertType<string>(result.value.message)
      } else {
        assertType<number>(result.value.value)
      }
    }
  })

  it('infers nested schemas', () => {
    const schema = object({
      items: array(object({name: string(), tags: array(string())})),
    })
    const result = parse(schema, null as unknown)
    if (result.ok) {
      assertType<{name: string; tags: string[]}[]>(result.value.items)
    }
  })

  it('Infer utility type works', () => {
    const _schema = object({name: string(), active: boolean()})
    type Expected = {name: string; active: boolean}
    assertType<Expected>(null as unknown as Infer<typeof _schema>)
    assertType<Infer<typeof _schema>>(null as unknown as Expected)
  })
})
