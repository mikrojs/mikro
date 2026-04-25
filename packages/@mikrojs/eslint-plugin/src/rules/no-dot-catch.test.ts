import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noDotCatch} from './no-dot-catch.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester()

ruleTester.run('no-dot-catch', noDotCatch, {
  valid: [
    // .then() is fine
    'promise.then(v => console.log(v))',
    // .finally() is fine
    'promise.finally(() => cleanup())',
    // Property named catch (not a call)
    'const c = obj.catch',
  ],
  invalid: [
    {
      code: 'promise.catch(e => console.error(e))',
      errors: [{messageId: 'noDotCatch'}],
    },
    {
      code: 'fetch("url").catch(handleError)',
      errors: [{messageId: 'noDotCatch'}],
    },
    {
      code: 'promise.then(ok).catch(fail)',
      errors: [{messageId: 'noDotCatch'}],
    },
  ],
})
