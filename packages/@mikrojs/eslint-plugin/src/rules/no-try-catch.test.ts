import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noTryCatch} from './no-try-catch.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester()

ruleTester.run('no-try-catch', noTryCatch, {
  valid: [
    // try/finally is allowed (cleanup)
    'try { doStuff() } finally { cleanup() }',
    // No try at all
    'doStuff()',
  ],
  invalid: [
    {
      code: 'try { doStuff() } catch (e) { console.error(e) }',
      errors: [{messageId: 'noTryCatch'}],
    },
    {
      code: 'try { doStuff() } catch { console.error("failed") }',
      errors: [{messageId: 'noTryCatch'}],
    },
    {
      code: 'try { doStuff() } catch (e) { handle(e) } finally { cleanup() }',
      errors: [{messageId: 'noTryCatch'}],
    },
  ],
})
