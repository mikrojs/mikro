#!/usr/bin/env node
import {spawn} from 'node:child_process'
import {join} from 'node:path'

if (process.env.MIKROJS_WORKSPACE === '1') {
  // Pass node flags via NODE_OPTIONS instead of CLI args so any node subprocess
  // we spawn later (notably simProcess via createSimTransport) inherits tsx
  // loading without each spawn site having to special-case workspace mode.
  // The stripTypeScriptTypes ExperimentalWarning is handled precisely by
  // suppressStripTypesWarning.ts (imported in cli.ts and simProcess.ts), so we
  // don't blanket-disable ExperimentalWarning here and keep other ones visible.
  const nodeOptions = [process.env.NODE_OPTIONS ?? '', '--conditions=development', '--import=tsx']
    .filter(Boolean)
    .join(' ')
  spawn(
    process.execPath,
    [join(import.meta.dirname, '../src/cli/cliWrapper.ts'), ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        TSX_TSCONFIG_PATH: join(import.meta.dirname, '../tsconfig.json'),
      },
    },
  ).on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
} else {
  await import('../dist/cli/cliWrapper.js')
}
