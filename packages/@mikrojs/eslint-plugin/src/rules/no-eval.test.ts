import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noEval} from './no-eval.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester()

ruleTester.run('no-eval', noEval, {
  valid: ['JSON.parse("{}") ', 'const fn = () => 42', 'function myEval(x: string) { return x }'],
  invalid: [
    {
      code: 'eval("1 + 2")',
      errors: [{messageId: 'noEval'}],
    },
    {
      code: 'const fn = new Function("a", "return a + 1")',
      errors: [{messageId: 'noNewFunction'}],
    },
  ],
})
