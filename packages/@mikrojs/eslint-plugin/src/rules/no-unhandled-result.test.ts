import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noUnhandledResult} from './no-unhandled-result.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const preamble = `
type OkResult<T> = { readonly ok: true; readonly value: T }
type ErrResult<E> = { readonly ok: false; readonly error: E }
type Result<T, E> = OkResult<T> | ErrResult<E>

type MyError = { name: 'Fail' }
declare function doThing(): Result<void, MyError>
declare function getValue(): Result<number, MyError>
declare function doAsync(): Promise<Result<void, MyError>>
declare function plain(): void
declare function getNumber(): number
declare function maybeResult(): Result<void, MyError> | void
declare function maybeUndefined(): Result<number, MyError> | undefined
declare function promiseMaybeResult(): Promise<Result<void, MyError> | void>
declare function errOnly(): ErrResult<MyError> | undefined
declare function asyncErrOnly(): Promise<ErrResult<MyError> | undefined>
`

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ['*.ts*'],
      },
    },
  },
})

ruleTester.run('no-unhandled-result', noUnhandledResult, {
  valid: [
    // Assigned to variable
    {code: `${preamble}\nconst r = doThing()`},
    // Checked inline
    {code: `${preamble}\nif (!doThing().ok) {}`},
    // Passed as argument
    {code: `${preamble}\nconsole.log(doThing())`},
    // Used in match
    {code: `${preamble}\nconst x = getValue().match({ok: v => v, err: () => 0})`},
    // Non-Result void function
    {code: `${preamble}\nplain()`},
    // Non-Result number function
    {code: `${preamble}\ngetNumber()`},
    // Await assigned
    {code: `${preamble}\nconst r = await doAsync()`},
    // Chained property access
    {code: `${preamble}\ndoThing().error`},
  ],
  invalid: [
    // Bare call returning Result
    {
      code: `${preamble}\ndoThing()`,
      errors: [{messageId: 'unhandled'}],
    },
    // Bare call returning Result<number, E>
    {
      code: `${preamble}\ngetValue()`,
      errors: [{messageId: 'unhandled'}],
    },
    // Await unwrapping Promise<Result>
    {
      code: `${preamble}\nawait doAsync()`,
      errors: [{messageId: 'unhandled'}],
    },
    // Result | void — still contains a Result
    {
      code: `${preamble}\nmaybeResult()`,
      errors: [{messageId: 'unhandled'}],
    },
    // Result | undefined — still contains a Result
    {
      code: `${preamble}\nmaybeUndefined()`,
      errors: [{messageId: 'unhandled'}],
    },
    // Promise<Result | void> — still contains a Result
    {
      code: `${preamble}\nawait promiseMaybeResult()`,
      errors: [{messageId: 'unhandled'}],
    },
    // ErrResult | undefined — error can still be silently ignored
    {
      code: `${preamble}\nerrOnly()`,
      errors: [{messageId: 'unhandled'}],
    },
    // Promise<ErrResult | undefined> — same, awaited
    {
      code: `${preamble}\nawait asyncErrOnly()`,
      errors: [{messageId: 'unhandled'}],
    },
  ],
})
