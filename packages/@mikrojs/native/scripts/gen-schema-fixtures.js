/**
 * Schema conformance fixtures: every case is run through the TypeScript
 * implementation here and its outcome recorded, then replayed through the
 * native module by test/schema_conformance_test.cpp.
 *
 * `mikro/schema` has two implementations of one contract: @mikrojs/schema
 * (host: the CLI evaluating mikro.config.ts, the registry, vitest) and
 * src/mik_schema.cpp (device). Two independent suites are not enough to keep
 * them together — the check-in wire had exactly this shape and drifted while
 * both suites stayed green (see test/ota_wire_fixtures_test.cpp). These
 * fixtures make the C++ answer the same questions the TypeScript answered.
 *
 * The recorded outcome is whatever core.ts does, bugs included. That is the
 * point: this file proves the two agree, and the vitest suite proves core.ts is
 * right. Regenerated on every test build so it cannot lag.
 *
 * Usage: node gen-schema-fixtures.js <outdir>
 */

import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

/* The source, not the package specifier: Node would resolve @mikrojs/schema
 * through its `import` condition to dist and make this need a build first. */
const s = await import('../../schema/src/core.ts')

const outDir = process.argv[2]
if (!outDir) {
  // eslint-disable-next-line no-console
  console.error('Usage: gen-schema-fixtures.js <outdir>')
  process.exit(1)
}

/* ── Cases ─────────────────────────────────────────────────────────── */

/* Constructor calls: the driver does S[call](...args) and compares the node it
 * builds, or the TypeError message it throws. Args are plain data because a
 * schema is plain data — that is what makes the same list drivable from C++. */
const CONSTRUCT_CASES = [
  ['string()', 'string', []],
  ['string with annotations', 'string', [{title: 'Name', description: 'Who', default: 'a'}]],
  ['string with constraints', 'string', [{minLength: 1, maxLength: 8, format: 'email'}]],
  ['string masked', 'string', [{mask: true}]],
  ['number()', 'number', []],
  ['number with bounds', 'number', [{min: 0, max: 10, integer: true, unit: 'ms'}]],
  ['number with default', 'number', [{default: 5}]],
  ['boolean with default', 'boolean', [{default: true}]],
  ['unknown()', 'unknown', []],
  ['literal string', 'literal', ['on']],
  ['literal number with title', 'literal', [3, {title: 'Three'}]],
  ['literal boolean', 'literal', [false]],
  ['array of numbers', 'array', [{kind: 'number'}]],
  ['array with item bounds', 'array', [{kind: 'string'}, {minItems: 1, maxItems: 4}]],
  ['array with default', 'array', [{kind: 'number'}, {default: [1, 2]}]],
  ['object empty', 'object', [{}]],
  ['object with fields', 'object', [{a: {kind: 'number'}, b: {kind: 'string'}}]],
  ['object with title', 'object', [{a: {kind: 'number'}}, {title: 'Group'}]],
  ['optional wraps', 'optional', [{kind: 'number'}]],
  ['tuple', 'tuple', [[{kind: 'number'}, {kind: 'string'}]]],
  ['union', 'union', [[{kind: 'number'}, {kind: 'string'}]]],
  [
    'enumOf',
    'enumOf',
    [
      [
        {value: 1, title: 'One'},
        {value: 2, description: 'Two'},
      ],
    ],
  ],
  ['enumOf with default', 'enumOf', [[{value: 'a'}, {value: 'b'}], {default: 'b'}]],
  [
    'taggedUnion',
    'taggedUnion',
    ['type', {a: {kind: 'object', shape: {}}, b: {kind: 'object', shape: {}}}],
  ],

  // Authoring rejections. These are TypeErrors thrown where the schema is
  // written, and they are as much a part of the contract as validation is.
  ['object rejects a default', 'object', [{}, {default: {}}]],
  ['optional rejects a defaulted inner', 'optional', [{kind: 'number', default: 1}]],
  ['array rejects an inner default', 'array', [{kind: 'number', default: 1}]],
  [
    'array rejects a nested inner default',
    'array',
    [{kind: 'object', shape: {a: {kind: 'number', default: 1}}}],
  ],
  ['tuple rejects an inner default', 'tuple', [[{kind: 'number', default: 1}]]],
  ['union rejects an inner default', 'union', [[{kind: 'number', default: 1}]]],
  [
    'taggedUnion rejects an inner default',
    'taggedUnion',
    ['t', {a: {kind: 'object', shape: {x: {kind: 'number', default: 1}}}}],
  ],
  ['default must match the node', 'number', [{default: 'nope'}]],
  ['array default must match', 'array', [{kind: 'number'}, {default: ['nope']}]],
  ['default must satisfy its own bound', 'number', [{min: 10, default: 5}]],
  ['default within its bound is fine', 'number', [{min: 1, max: 10, default: 5}]],
  ['default must satisfy minLength', 'string', [{minLength: 3, default: 'ab'}]],
]

/* Validation: schemas are built with the constructors for readability and
 * serialized as data, which is what the device receives anyway. */
const V = {
  str: s.string(),
  num: s.number(),
  bool: s.boolean(),
  unk: s.unknown(),
  litOn: s.literal('on'),
  lit3: s.literal(3),
  arrNum: s.array(s.number()),
  obj: s.object({a: s.number(), b: s.string()}),
  objOpt: s.object({a: s.number(), b: s.optional(s.string())}),
  nested: s.object({outer: s.object({inner: s.array(s.number())})}),
  tup: s.tuple([s.number(), s.string()]),
  uni: s.union([s.number(), s.string()]),
  tagged: s.taggedUnion('type', {
    move: s.object({x: s.number()}),
    stop: s.object({}),
  }),
  optNum: s.optional(s.number()),
  bounded: s.number({min: 0, max: 10}),
  whole: s.number({integer: true}),
  fractional: s.number({min: 0.5, max: 2.5}),
  sized: s.string({minLength: 2, maxLength: 4}),
  items: s.array(s.number(), {minItems: 1, maxItems: 3}),
  emailed: s.string({format: 'email'}),
  boundedObj: s.object({pin: s.number({min: 0, max: 30, integer: true})}),
  /* The rule the two-pass arrangement got wrong: a union accepts what ANY
   * member accepts, so 150 has to pass on the second member even though it
   * matches the first member's shape and fails its bound. */
  splitRange: s.union([s.number({max: 10}), s.number({min: 100})]),
}

const VALIDATE_CASES = [
  ['string accepts', V.str, 'hello'],
  ['string rejects a number', V.str, 42],
  ['string rejects null', V.str, null],
  ['string rejects undefined', V.str, undefined],
  ['number accepts', V.num, 1.5],
  ['number accepts a negative', V.num, -7],
  ['number rejects NaN', V.num, NaN],
  ['number rejects a string', V.num, '1'],
  ['boolean accepts', V.bool, false],
  ['boolean rejects 0', V.bool, 0],
  ['unknown accepts a string', V.unk, 'x'],
  ['unknown accepts undefined', V.unk, undefined],
  ['unknown accepts an object', V.unk, {a: 1}],
  ['literal accepts its value', V.litOn, 'on'],
  ['literal rejects another string', V.litOn, 'off'],
  ['literal number accepts', V.lit3, 3],
  ['literal number rejects', V.lit3, 4],
  ['literal reports undefined', V.lit3, undefined],
  ['array accepts', V.arrNum, [1, 2, 3]],
  ['array accepts empty', V.arrNum, []],
  ['array rejects a non-array', V.arrNum, 'no'],
  ['array rejects an object', V.arrNum, {}],
  ['array reports the bad index', V.arrNum, [1, 'two', 3]],
  ['object accepts', V.obj, {a: 1, b: 'x'}],
  ['object ignores extra keys', V.obj, {a: 1, b: 'x', extra: true}],
  ['object reports a missing field', V.obj, {a: 1}],
  ['object reports a bad field', V.obj, {a: 1, b: 2}],
  ['object rejects an array', V.obj, [1, 2]],
  ['object rejects null', V.obj, null],
  ['optional field may be absent', V.objOpt, {a: 1}],
  ['optional field may be present', V.objOpt, {a: 1, b: 'x'}],
  ['optional field still typechecked', V.objOpt, {a: 1, b: 2}],
  ['nested reports a deep path', V.nested, {outer: {inner: [1, 'no']}}],
  ['nested accepts', V.nested, {outer: {inner: []}}],
  ['tuple accepts', V.tup, [1, 'x']],
  ['tuple rejects a short one', V.tup, [1]],
  ['tuple rejects a long one', V.tup, [1, 'x', 3]],
  ['tuple reports a bad position', V.tup, ['x', 'x']],
  ['union accepts the first', V.uni, 1],
  ['union accepts the second', V.uni, 'x'],
  ['union rejects neither', V.uni, true],
  ['taggedUnion accepts a branch', V.tagged, {type: 'move', x: 1}],
  ['taggedUnion accepts the empty branch', V.tagged, {type: 'stop'}],
  ['taggedUnion reports a missing tag', V.tagged, {x: 1}],
  ['taggedUnion reports an unknown tag', V.tagged, {type: 'spin'}],
  ['taggedUnion reports a non-primitive tag', V.tagged, {type: {}}],
  ['taggedUnion validates the branch', V.tagged, {type: 'move', x: 'no'}],
  ['taggedUnion rejects an array', V.tagged, []],
  ['bare optional accepts undefined', V.optNum, undefined],
  ['bare optional accepts a value', V.optNum, 1],
  ['bare optional rejects a bad value', V.optNum, 'x'],

  /* Bounds. These used to be host-only; parse() now enforces everything except
   * format and unit wherever it runs. */
  ['min accepts the boundary', V.bounded, 0],
  ['max accepts the boundary', V.bounded, 10],
  ['below min rejected', V.bounded, -1],
  ['above max rejected', V.bounded, 11],
  ['integer accepts a whole number', V.whole, 4],
  ['integer rejects a fraction', V.whole, 4.5],
  ['integer rejects Infinity', V.whole, Infinity],
  ['fractional bounds accept', V.fractional, 1.25],
  ['fractional bounds report the bound as written', V.fractional, 0.25],
  ['minLength accepts the boundary', V.sized, 'ab'],
  ['maxLength accepts the boundary', V.sized, 'abcd'],
  ['shorter than minLength rejected', V.sized, 'a'],
  ['longer than maxLength rejected', V.sized, 'abcde'],
  ['length counts UTF-16 units', V.sized, '\u{1F600}'],
  ['minItems accepts the boundary', V.items, [1]],
  ['maxItems accepts the boundary', V.items, [1, 2, 3]],
  ['fewer than minItems rejected', V.items, []],
  ['more than maxItems rejected', V.items, [1, 2, 3, 4]],
  ['length is checked before elements', V.items, [1, 2, 3, 'no']],
  ['bounds report the field path', V.boundedObj, {pin: 200}],
  ['format is not checked here', V.emailed, 'not-an-email'],
  ['a union member failing its bound falls through', V.splitRange, 150],
  ['a union with no member in range is rejected', V.splitRange, 50],

  /* Prototype-chain hazards. core.ts uses Object.hasOwn at three sites so an
   * inherited member cannot stand in for a field or a branch; JS_GetPropertyStr
   * walks the prototype chain and would reopen exactly this. */
  ['object does not read an inherited field', s.object({constructor: s.number()}), {}],
  [
    'object accepts a real constructor field',
    s.object({constructor: s.number()}),
    {constructor: 1},
  ],
  ['taggedUnion does not dispatch on an inherited tag', V.tagged, {type: 'constructor'}],
  ['taggedUnion does not dispatch on toString', V.tagged, {type: 'toString'}],
  ['object does not read an inherited __proto__', s.object({a: s.number()}), {}],
]

const APPLY_DEFAULTS_CASES = [
  ['fills a scalar default', s.object({a: s.number({default: 5})}), undefined],
  ['keeps a present value', s.object({a: s.number({default: 5})}), {a: 9}],
  ['drops unknown keys', s.object({a: s.number({default: 5})}), {a: 1, z: 2}],
  ['leaves an optional absent', s.object({a: s.optional(s.number())}), {}],
  ['keeps a present optional', s.object({a: s.optional(s.number())}), {a: 1}],
  ['recurses into nested objects', s.object({o: s.object({a: s.number({default: 2})})}), {}],
  ['array default fills', s.object({a: s.array(s.number(), {default: [1]})}), {}],
  ['array without a default is empty', s.object({a: s.array(s.number())}), {}],
  ['a present non-object stays as-is', s.object({a: s.number()}), 42],
  ['does not fill through an inherited key', s.object({constructor: s.number({default: 1})}), {}],
  ['unknown passes through', s.unknown(), undefined],
  ['scalar default at the root', s.number({default: 3}), undefined],
  /* Hand-built AST: the constructors reject a default that breaks its own
   * bound, but a schema that arrived as JSON ran none of them, and
   * applyDefaults must still fill without validating. */
  [
    'a default outside its own bound still fills',
    {kind: 'object', shape: {a: {kind: 'number', min: 10, default: 5}}},
    {},
  ],
]

/* ── Recording ─────────────────────────────────────────────────────── */

function recordConstruct([name, call, args]) {
  try {
    return {name, kind: 'construct', call, args, expect: s[call](...args)}
  } catch (e) {
    return {name, kind: 'construct', call, args, throws: e.message}
  }
}

function recordValidate([name, schema, value]) {
  const result = s.validate(schema, value, '')
  return {
    name,
    kind: 'validate',
    schema,
    value,
    expect: result === null ? null : {message: result.error.message, path: result.error.path},
  }
}

function recordApplyDefaults([name, schema, value]) {
  return {name, kind: 'applyDefaults', schema, value, expect: s.applyDefaults(schema, value)}
}

/* ── Emitting ──────────────────────────────────────────────────────── */

/* JS source, not JSON: the cases carry undefined and NaN, which JSON cannot
 * represent and which are exactly the values the edge cases are about. */
function js(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN'
    if (value === Infinity) return 'Infinity'
    if (value === -Infinity) return '-Infinity'
    return String(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(js).join(',')}]`
  if (typeof value === 'object') {
    const body = Object.keys(value)
      .map((k) => `${JSON.stringify(k)}:${js(value[k])}`)
      .join(',')
    return `{${body}}`
  }
  throw new TypeError(`cannot serialize ${typeof value}`)
}

const cases = [
  ...CONSTRUCT_CASES.map(recordConstruct),
  ...VALIDATE_CASES.map(recordValidate),
  ...APPLY_DEFAULTS_CASES.map(recordApplyDefaults),
]

const body = cases.map((c) => `  ${js(c)},`).join('\n')
const source = `/* GENERATED by scripts/gen-schema-fixtures.js. Do not edit. */
const cases = [
${body}
]
`

mkdirSync(outDir, {recursive: true})
writeFileSync(join(outDir, 'schema-fixtures.js'), source)

// eslint-disable-next-line no-console
console.log(`schema fixtures: ${cases.length} cases -> ${join(outDir, 'schema-fixtures.js')}`)
