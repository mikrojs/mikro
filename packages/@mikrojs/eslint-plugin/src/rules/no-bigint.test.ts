import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noBigInt} from './no-bigint.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester()

ruleTester.run('no-bigint', noBigInt, {
  valid: [
    'const n = 42',
    'Number.MAX_SAFE_INTEGER',
    'new Int32Array(1)',
    'const obj = {BigInt: 1}',
    'foo.BigInt',
  ],
  invalid: [
    {
      code: 'const n = 123n',
      errors: [{messageId: 'noBigInt'}],
    },
    {
      code: 'const n = BigInt(5)',
      errors: [{messageId: 'noBigInt'}],
    },
    {
      code: 'BigInt.asIntN(64, 1n)',
      errors: [{messageId: 'noBigInt'}, {messageId: 'noBigInt'}],
    },
    {
      code: 'new BigInt64Array(1)',
      errors: [{messageId: 'noBigInt'}],
    },
    {
      code: 'new BigUint64Array(1)',
      errors: [{messageId: 'noBigInt'}],
    },
    {
      code: 'BigInt64Array.from([])',
      errors: [{messageId: 'noBigInt'}],
    },
  ],
})
