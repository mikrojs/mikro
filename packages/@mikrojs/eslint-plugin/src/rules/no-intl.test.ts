import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noIntl} from './no-intl.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester()

ruleTester.run('no-intl', noIntl, {
  valid: ['new Date().toISOString()', 'const s = String(42)', 'number.toFixed(2)'],
  invalid: [
    {
      code: 'new Intl.DateTimeFormat("en-US")',
      errors: [{messageId: 'noIntl'}],
    },
    {
      code: 'new Intl.NumberFormat("de-DE")',
      errors: [{messageId: 'noIntl'}],
    },
    {
      code: 'Intl.Collator("en")',
      errors: [{messageId: 'noIntl'}],
    },
  ],
})
