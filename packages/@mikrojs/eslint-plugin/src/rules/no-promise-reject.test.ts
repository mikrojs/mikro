import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noPromiseReject} from './no-promise-reject.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester()

ruleTester.run('no-promise-reject', noPromiseReject, {
  valid: [
    // Promise.resolve is fine
    'Promise.resolve(42)',
    // new Promise with only resolve
    'new Promise((resolve) => resolve(42))',
    // Regular function named reject (not a Promise callback)
    'function reject(x: string) { return x }; reject("hi")',
  ],
  invalid: [
    {
      code: 'Promise.reject(new Error("fail"))',
      errors: [{messageId: 'noPromiseReject'}],
    },
    {
      code: 'Promise.reject("fail")',
      errors: [{messageId: 'noPromiseReject'}],
    },
    {
      code: 'new Promise((resolve, reject) => { reject(new Error("fail")) })',
      errors: [{messageId: 'noRejectCall'}],
    },
    {
      code: 'new Promise(function(resolve, reject) { reject("fail") })',
      errors: [{messageId: 'noRejectCall'}],
    },
  ],
})
