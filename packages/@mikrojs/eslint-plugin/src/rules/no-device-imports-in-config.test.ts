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
      code: "import {defineConfig} from 'mikro'",
      filename: 'mikro.config.ts',
    },
    {
      code: "import * as fs from 'node:fs'",
      filename: 'mikro.config.ts',
    },
    {
      code: "import {pin} from 'mikro/pin'",
      filename: 'app.ts',
    },
    {
      code: "import {wifi} from 'mikro/wifi'\nimport {pin} from 'mikro/pin'",
      filename: 'src/main.ts',
    },
  ],
  invalid: [
    {
      code: "import {pin} from 'mikro/pin'",
      filename: 'mikro.config.ts',
      errors: [{messageId: 'noDeviceImport'}],
    },
    {
      code: "import {wifi} from 'mikro/wifi'",
      filename: 'mikro.config.js',
      errors: [{messageId: 'noDeviceImport'}],
    },
    {
      code: "const m = await import('mikro/pin')",
      filename: 'mikro.config.ts',
      errors: [{messageId: 'noDeviceImport'}],
    },
    {
      code: "export {pin} from 'mikro/pin'",
      filename: 'mikro.config.ts',
      errors: [{messageId: 'noDeviceImport'}],
    },
    {
      code: "export * from 'mikro/wifi'",
      filename: 'mikro.config.ts',
      errors: [{messageId: 'noDeviceImport'}],
    },
  ],
})
