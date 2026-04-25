import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noThrow} from './no-throw.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester()

ruleTester.run('no-throw', noThrow, {
  valid: ['console.error("something failed")', 'const err = new Error("test")'],
  invalid: [
    {
      code: 'throw new Error("fail")',
      errors: [{messageId: 'noThrow'}],
    },
    {
      code: 'throw "fail"',
      errors: [{messageId: 'noThrow'}],
    },
    {
      code: 'function f() { throw new Error("fail") }',
      errors: [{messageId: 'noThrow'}],
    },
  ],
})
