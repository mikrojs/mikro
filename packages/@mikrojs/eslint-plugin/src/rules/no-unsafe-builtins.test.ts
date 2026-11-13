import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noUnsafeBuiltins} from './no-unsafe-builtins.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester()

// [call, its safe() form]
const bare = [
  ['JSON.stringify(value)', 'safe(JSON.stringify, value)'],
  ['atob(data)', 'safe(atob, data)'],
  ['btoa(data)', 'safe(btoa, data)'],
  ['decodeURI(s)', 'safe(decodeURI, s)'],
  ['encodeURI(s)', 'safe(encodeURI, s)'],
  ['encodeURIComponent(s)', 'safe(encodeURIComponent, s)'],
  ['String.fromCodePoint(cp)', 'safe(String.fromCodePoint, cp)'],
  ['RegExp(`^${prefix}`)', 'safe(RegExp, `^${prefix}`)'],
  ['JSON.parse()', 'safe(JSON.parse)'],
  // Not plain data: could be a BigInt, a cycle, or a callback that throws
  ['JSON.stringify({n: 1n})', 'safe(JSON.stringify, {n: 1n})'],
  ['JSON.stringify({a: [x]})', 'safe(JSON.stringify, {a: [x]})'],
  ['JSON.stringify({...o})', 'safe(JSON.stringify, {...o})'],
  ['JSON.stringify({[k]: 1})', 'safe(JSON.stringify, {[k]: 1})'],
  ['JSON.stringify({get a() { return 1 }})', 'safe(JSON.stringify, {get a() { return 1 }})'],
  ['JSON.stringify({a: 1}, (k, v) => v)', 'safe(JSON.stringify, {a: 1}, (k, v) => v)'],
].map(([code, fixed]) => ({
  code: code!,
  errors: [
    {
      messageId: 'throwingBuiltin' as const,
      suggestions: [
        {
          messageId: 'useSafe' as const,
          output: `import {safe} from 'mikro/result'\n${fixed}`,
        },
      ],
    },
  ],
}))

ruleTester.run('no-unsafe-builtins', noUnsafeBuiltins, {
  valid: [
    "import {safe} from 'mikro/result'\nsafe(JSON.parse, text)",
    "import {safe} from 'mikro/result'\nsafe(decodeURIComponent, raw)",
    "import {safe} from 'mikro/result'\nsafe(RegExp, pattern, 'i')",
    "import {safe} from 'mikro/result'\nsafe(String.fromCodePoint, cp)",
    "import {safe} from 'mikro/result'\nsafe(JSON.parse, text, (k, v) => v)",
    "import {safe as s} from 'mikro/result'\ns(atob, data)",
    "import * as R from 'mikro/result'\nR.safe(btoa, data)",
    // Literal patterns are checked by whoever wrote them
    "new RegExp('a+', 'i')",
    'RegExp(`^x$`)',
    // Plain data can't make JSON.stringify throw
    "JSON.stringify({hello: 'mikro', n: -42, ok: true, none: null, list: [1, 'a', [], {}]})",
    "JSON.stringify(['a', `b`], ['a'], 2)",
    'JSON.stringify(42)',
    // Shadowed names are not the builtins
    'const atob = (s: string) => s\natob(x)',
    'function f(JSON: {parse(s: string): unknown}) { return JSON.parse(s) }',
    // Not on the list
    'JSON.rawJSON(x)',
    'String.raw`x`',
    // Config files run in Node
    {code: 'JSON.parse(text)', filename: 'mikro.config.ts'},
    // A parameter shadowing the imported safe
    "import {safe} from 'mikro/result'\nfunction f(safe: (x: unknown) => void) { safe(myFn) }",
    // A safe that isn't from mikro/result
    'const safe = (f: unknown) => f\nsafe(myFn)',
  ],
  invalid: [
    {
      code: 'JSON.parse(text)',
      errors: [
        {
          messageId: 'throwingBuiltin',
          data: {name: 'JSON.parse'},
          suggestions: [
            {
              messageId: 'useSafe',
              output: "import {safe} from 'mikro/result'\nsafe(JSON.parse, text)",
            },
          ],
        },
      ],
    },
    {
      code: "import {ok} from 'mikro/result'\nconst v = decodeURIComponent(raw)",
      errors: [
        {
          messageId: 'throwingBuiltin',
          suggestions: [
            {
              messageId: 'useSafe',
              output:
                "import {ok, safe} from 'mikro/result'\nconst v = safe(decodeURIComponent, raw)",
            },
          ],
        },
      ],
    },
    {
      code: "import {safe as s} from 'mikro/result'\nnew RegExp(pattern, 'g')",
      errors: [
        {
          messageId: 'throwingBuiltin',
          suggestions: [
            {
              messageId: 'useSafe',
              output: "import {safe as s} from 'mikro/result'\ns(RegExp, pattern, 'g')",
            },
          ],
        },
      ],
    },
    ...bare,
    {
      code: "import * as R from 'mikro/result'\natob(data)",
      errors: [
        {
          messageId: 'throwingBuiltin',
          suggestions: [
            {messageId: 'useSafe', output: "import * as R from 'mikro/result'\nR.safe(atob, data)"},
          ],
        },
      ],
    },
    // The name safe is taken, so no suggestion
    {
      code: 'const safe = 1\nJSON.parse(text)',
      errors: [{messageId: 'throwingBuiltin', suggestions: []}],
    },
    {
      code: "import {safe} from 'mikro/result'\nfunction f(safe: number) { return atob(x) }",
      errors: [{messageId: 'throwingBuiltin', suggestions: []}],
    },
    {
      code: "import {safe} from 'mikro/result'\nsafe(myParse, text)",
      errors: [{messageId: 'notABuiltin'}],
    },
    {
      code: "import {safe} from 'mikro/result'\nsafe(() => JSON.parse(text))",
      errors: [
        {messageId: 'notABuiltin'},
        {
          messageId: 'throwingBuiltin',
          suggestions: [
            {
              messageId: 'useSafe',
              output: "import {safe} from 'mikro/result'\nsafe(() => safe(JSON.parse, text))",
            },
          ],
        },
      ],
    },
    {
      code: "import * as R from 'mikro/result'\nR.safe(JSON?.parse, text)",
      errors: [{messageId: 'notABuiltin'}],
    },
  ],
})
