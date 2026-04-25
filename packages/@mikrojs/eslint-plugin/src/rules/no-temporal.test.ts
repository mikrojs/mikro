import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noTemporal} from './no-temporal.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester()

ruleTester.run('no-temporal', noTemporal, {
  valid: ['new Date()', 'Date.now()', 'const d = new Date().toISOString()'],
  invalid: [
    {
      code: 'Temporal.Now.instant()',
      errors: [{messageId: 'noTemporal'}],
    },
    {
      code: 'Temporal.PlainDate.from("2025-01-01")',
      errors: [{messageId: 'noTemporal'}],
    },
    {
      code: 'Temporal.Duration.from({hours: 1})',
      errors: [{messageId: 'noTemporal'}],
    },
  ],
})
