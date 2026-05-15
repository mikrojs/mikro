#!/usr/bin/env node
import {spawn} from 'node:child_process'
import {join} from 'node:path'

if (process.env.MIKROJS_WORKSPACE === '1') {
  spawn(
    process.execPath,
    [
      '--no-warnings=ExperimentalWarning',
      '--conditions=development',
      '--import=tsx',
      join(import.meta.dirname, '../src/cli/cliWrapper.ts'),
      ...process.argv.slice(2),
    ],
    {stdio: 'inherit'},
  ).on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
} else {
  await import('../dist/cli/cliWrapper.js')
}
