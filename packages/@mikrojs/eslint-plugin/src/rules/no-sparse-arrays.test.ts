import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noSparseArrays} from './no-sparse-arrays.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester()

ruleTester.run('no-sparse-arrays', noSparseArrays, {
  valid: [
    // Dense array is fine
    'const arr = [1, 2, 3]',
    // Explicit undefined is fine
    'const arr = [1, undefined, 3]',
    // Empty array is fine
    'const arr: number[] = []',
    // Delete on object property is fine
    'delete obj.prop',
    // Splice is fine
    'arr.splice(1, 1)',
  ],
  invalid: [
    {
      code: 'const arr = [1,,3]',
      errors: [{messageId: 'noSparse'}],
    },
    {
      code: 'const arr = [,,]',
      errors: [{messageId: 'noSparse'}],
    },
    {
      code: 'delete arr[0]',
      errors: [{messageId: 'noDeleteElement'}],
    },
    {
      code: 'delete arr[i]',
      errors: [{messageId: 'noDeleteElement'}],
    },
  ],
})
