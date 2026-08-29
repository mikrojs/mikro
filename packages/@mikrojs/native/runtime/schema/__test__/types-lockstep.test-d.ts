import type * as Core from '@mikrojs/schema'
import {describe, expectTypeOf, it} from 'vitest'

import type * as Types from '../types.js'

/* types.ts declares what native:mikro/schema provides, and it is a hand-written
 * mirror of @mikrojs/schema rather than a re-export of it, for a reason:
 * re-exporting would drag that package's implementation into every downstream
 * project's compilation, where consumer flags apply to it (a scaffolded project
 * sets `allowUnreachableCode: false` and core.ts trips it). The package keeps a
 * `development` condition so in-workspace edits need no build, which means
 * in-workspace resolution reaches the raw source either way.
 *
 * Nothing else keeps the two in step, and they had already drifted: SchemaError
 * was readonly in the implementation and mutable here, which stopped it
 * reducing against structurally equal error unions in kv. These assertions fail
 * the build when one gains a member the other lacks, or a signature changes. */
describe('types.ts mirrors @mikrojs/schema', () => {
  it('mirrors the node interfaces', () => {
    expectTypeOf<Types.StringSchema>().toEqualTypeOf<Core.StringSchema>()
    expectTypeOf<Types.NumberSchema>().toEqualTypeOf<Core.NumberSchema>()
    expectTypeOf<Types.BooleanSchema>().toEqualTypeOf<Core.BooleanSchema>()
    expectTypeOf<Types.UnknownSchema>().toEqualTypeOf<Core.UnknownSchema>()
    expectTypeOf<Types.LiteralSchema<'a'>>().toEqualTypeOf<Core.LiteralSchema<'a'>>()
    expectTypeOf<Types.ArraySchema<Core.StringSchema>>().toEqualTypeOf<
      Core.ArraySchema<Core.StringSchema>
    >()
    expectTypeOf<Types.ObjectSchema<{a: Core.StringSchema}>>().toEqualTypeOf<
      Core.ObjectSchema<{a: Core.StringSchema}>
    >()
    expectTypeOf<Types.OptionalSchema<Core.StringSchema>>().toEqualTypeOf<
      Core.OptionalSchema<Core.StringSchema>
    >()
    expectTypeOf<Types.TupleSchema<[Core.StringSchema]>>().toEqualTypeOf<
      Core.TupleSchema<[Core.StringSchema]>
    >()
    expectTypeOf<Types.UnionSchema<[Core.StringSchema]>>().toEqualTypeOf<
      Core.UnionSchema<[Core.StringSchema]>
    >()
    expectTypeOf<
      Types.TaggedUnionSchema<'kind', {a: Core.ObjectSchema<{x: Core.StringSchema}>}>
    >().toEqualTypeOf<
      Core.TaggedUnionSchema<'kind', {a: Core.ObjectSchema<{x: Core.StringSchema}>}>
    >()
  })

  it('mirrors the unions, options and error type', () => {
    expectTypeOf<Types.Schema>().toEqualTypeOf<Core.Schema>()
    expectTypeOf<Types.SchemaError>().toEqualTypeOf<Core.SchemaError>()
    expectTypeOf<Types.ScalarOptions<string>>().toEqualTypeOf<Core.ScalarOptions<string>>()
    expectTypeOf<Types.DefaultOption<string>>().toEqualTypeOf<Core.DefaultOption<string>>()
    expectTypeOf<Types.DisplayOptions>().toEqualTypeOf<Core.DisplayOptions>()
    expectTypeOf<Types.MaskableOptions<string>>().toEqualTypeOf<Core.MaskableOptions<string>>()
    expectTypeOf<Types.EnumEntry<string>>().toEqualTypeOf<Core.EnumEntry<string>>()
    expectTypeOf<Types.Format>().toEqualTypeOf<Core.Format>()
    expectTypeOf<Types.Unit>().toEqualTypeOf<Core.Unit>()
    expectTypeOf<Types.StringOptions<string>>().toEqualTypeOf<Core.StringOptions<string>>()
    expectTypeOf<Types.NumberOptions<number>>().toEqualTypeOf<Core.NumberOptions<number>>()
    expectTypeOf<Types.ArrayOptions<string[]>>().toEqualTypeOf<Core.ArrayOptions<string[]>>()
  })

  it('mirrors the inference helpers', () => {
    type Shape = Core.ObjectSchema<{a: Core.StringSchema; b: Core.NumberSchema}>
    expectTypeOf<Types.Infer<Shape>>().toEqualTypeOf<Core.Infer<Shape>>()
    expectTypeOf<Types.InferRead<Shape>>().toEqualTypeOf<Core.InferRead<Shape>>()
  })

  /* Instantiated, not raw generic signatures: the two modules' `Infer` and
   * `Schema` are distinct symbols, so an uninstantiated generic never compares
   * equal across them however identical the bodies. Instantiating forces the
   * conditional types to resolve to concrete shapes that can be compared. */
  it('mirrors the constructor return types', () => {
    type S = Core.StringSchema
    expectTypeOf<ReturnType<typeof Types.string<'a'>>>().toEqualTypeOf<
      ReturnType<typeof Core.string<'a'>>
    >()
    expectTypeOf<ReturnType<typeof Types.number<1>>>().toEqualTypeOf<
      ReturnType<typeof Core.number<1>>
    >()
    expectTypeOf<ReturnType<typeof Types.boolean<true>>>().toEqualTypeOf<
      ReturnType<typeof Core.boolean<true>>
    >()
    expectTypeOf<ReturnType<typeof Types.unknown>>().toEqualTypeOf<
      ReturnType<typeof Core.unknown>
    >()
    expectTypeOf<ReturnType<typeof Types.literal<'a', 'a'>>>().toEqualTypeOf<
      ReturnType<typeof Core.literal<'a', 'a'>>
    >()
    expectTypeOf<ReturnType<typeof Types.array<S, string[]>>>().toEqualTypeOf<
      ReturnType<typeof Core.array<S, string[]>>
    >()
    expectTypeOf<ReturnType<typeof Types.object<{a: S}>>>().toEqualTypeOf<
      ReturnType<typeof Core.object<{a: S}>>
    >()
    expectTypeOf<ReturnType<typeof Types.tuple<[S], [string]>>>().toEqualTypeOf<
      ReturnType<typeof Core.tuple<[S], [string]>>
    >()
    expectTypeOf<ReturnType<typeof Types.optional<S>>>().toEqualTypeOf<
      ReturnType<typeof Core.optional<S>>
    >()
    expectTypeOf<ReturnType<typeof Types.union<[S], string>>>().toEqualTypeOf<
      ReturnType<typeof Core.union<[S], string>>
    >()
    expectTypeOf<ReturnType<typeof Types.enumOf<[{value: 'a'}], 'a'>>>().toEqualTypeOf<
      ReturnType<typeof Core.enumOf<[{value: 'a'}], 'a'>>
    >()
    expectTypeOf<ReturnType<typeof Types.applyDefaults>>().toEqualTypeOf<
      ReturnType<typeof Core.applyDefaults>
    >()
  })
})
