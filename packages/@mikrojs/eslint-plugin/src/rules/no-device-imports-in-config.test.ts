import {RuleTester} from '@typescript-eslint/rule-tester'
import {afterAll, describe, it} from 'vitest'

import {noDeviceImportsInConfig} from './no-device-imports-in-config.js'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester()

ruleTester.run('no-device-imports-in-config', noDeviceImportsInConfig, {
  valid: [
    {
      code: "import {defineConfig} from 'mikrojs'",
      filename: 'mikro.config.ts',
    },
    {
      code: "import * as fs from 'node:fs'",
      filename: 'mikro.config.ts',
    },
    {
      code: "import {pin} from 'mikrojs/pin'",
      filename: 'app.ts',
    },
    {
      code: "import {wifi} from 'mikrojs/wifi'\nimport {pin} from 'mikrojs/pin'",
      filename: 'src/main.ts',
    },
  ],
  invalid: [
    {
      code: "import {pin} from 'mikrojs/pin'",
      filename: 'mikro.config.ts',
      errors: [{messageId: 'noDeviceImport'}],
    },
    {
      code: "import {wifi} from 'mikrojs/wifi'",
      filename: 'mikro.config.js',
      errors: [{messageId: 'noDeviceImport'}],
    },
    {
      code: "const m = await import('mikrojs/pin')",
      filename: 'mikro.config.ts',
      errors: [{messageId: 'noDeviceImport'}],
    },
    {
      code: "export {pin} from 'mikrojs/pin'",
      filename: 'mikro.config.ts',
      errors: [{messageId: 'noDeviceImport'}],
    },
    {
      code: "export * from 'mikrojs/wifi'",
      filename: 'mikro.config.ts',
      errors: [{messageId: 'noDeviceImport'}],
    },
  ],
})
