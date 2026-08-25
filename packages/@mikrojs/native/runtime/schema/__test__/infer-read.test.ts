import {describe, expectTypeOf, it} from 'vitest'

import {
  array,
  boolean,
  type Infer,
  type InferRead,
  literal,
  number,
  object,
  optional,
  string,
  taggedUnion,
  tuple,
  union,
} from '../core.js'

/* InferRead is the read type: what applyDefaults alone can hand back. A field
 * defaults cannot fill reads as optional; Infer keeps it required, because
 * that is the type an operator writes. */
describe('InferRead', () => {
  it('leaves an all-defaults schema fully required', () => {
    const _schema = object({
      interval: number({default: 60}),
      host: string({default: 'mqtt.local'}),
      on: boolean({default: true}),
      level: union([literal('debug'), literal('info')], {default: 'info'}),
    })
    expectTypeOf<InferRead<typeof _schema>>().toEqualTypeOf<{
      interval: number
      host: string
      on: boolean
      level: 'debug' | 'info'
    }>()
  })

  it('makes a defaultless leaf optional to read and keeps it required to write', () => {
    const _schema = object({mqttUrl: string(), interval: number({default: 60})})
    expectTypeOf<InferRead<typeof _schema>>().toEqualTypeOf<{
      interval: number
      mqttUrl?: string
    }>()
    expectTypeOf<Infer<typeof _schema>>().toEqualTypeOf<{
      mqttUrl: string
      interval: number
    }>()
  })

  it('follows a taggedUnion whole-value default', () => {
    const branches = {dhcp: object({}), static: object({ip: string()})}
    const _withDefault = object({net: taggedUnion('mode', branches, {default: {mode: 'dhcp'}})})
    const _without = object({net: taggedUnion('mode', branches)})
    // the branch type is unchanged either way; only presence differs
    type Net = Infer<(typeof _without)['shape']['net']>
    expectTypeOf<InferRead<typeof _withDefault>>().toEqualTypeOf<{net: Net}>()
    expectTypeOf<InferRead<typeof _without>>().toEqualTypeOf<{net?: Net}>()
  })

  it('follows a tuple whole-value default, and reads a defaultless array as absent', () => {
    const _schema = object({
      at: tuple([number(), number()], {default: [0, 0]}),
      span: tuple([number(), number()]),
      // the materialized defaults omit a defaultless array, so a read may
      // find it absent until a document supplies it
      tags: array(string()),
      pins: array(number(), {default: [2]}),
    })
    expectTypeOf<InferRead<typeof _schema>>().toEqualTypeOf<{
      at: [number, number]
      pins: number[]
      span?: [number, number]
      tags?: string[]
    }>()
  })

  it('keeps a nested object only when defaults fill it completely', () => {
    // mqtt has a defaultless field, so the materialized defaults omit the
    // whole object and the read may find the field absent; a fully covered
    // object stays required, its own optional members intact.
    const _partial = object({
      mqtt: object({host: string({default: 'mqtt.local'}), port: number(), key: string()}),
      label: optional(string()),
    })
    expectTypeOf<InferRead<typeof _partial>>().toEqualTypeOf<{
      mqtt?: {host: string; port?: number; key?: string}
      label?: string | undefined
    }>()
    const _complete = object({
      mqtt: object({host: string({default: 'mqtt.local'}), label: optional(string())}),
    })
    expectTypeOf<InferRead<typeof _complete>>().toEqualTypeOf<{
      mqtt: {host: string; label?: string | undefined}
    }>()
  })

  it('types array elements and union branches as complete values', () => {
    const _schema = object({
      items: array(object({name: string(), size: number()})),
    })
    expectTypeOf<InferRead<typeof _schema>>().toEqualTypeOf<{
      items?: {name: string; size: number}[]
    }>()
  })
})
