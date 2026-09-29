import {command, constant, message, multiple, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'

import {port} from '../lib/portValueParser.js'

export const args = command(
  'test',
  object({
    action: constant('test'),
    filters: multiple(
      argument(string({metavar: 'PATH_OR_PATTERN'}), {
        description: message`Test file paths and/or glob patterns. Pass one or more. Default: **/*.test.ts`,
      }),
    ),
    port: optional(
      option('-p', '--port', port(), {
        description: message`Serial port of device`,
      }),
    ),
    env: optional(
      option('--env-file', path({metavar: 'FILE', type: 'file', mustExist: true}), {
        description: message`Path to .env file`,
      }),
    ),
    noAutoEnv: optional(
      flag('--no-auto-env', {
        description: message`Skip auto-loading of .env and .env.test from the project root`,
      }),
    ),
    noMinify: optional(flag('--no-minify', {description: message`Skip minification`})),
    minifier: optional(
      option('--minifier', string({metavar: 'NAME'}), {
        description: message`Minifier: esbuild, terser, or swc (default: esbuild)`,
      }),
    ),
    minifyLevel: optional(
      option('--minify-level', string({metavar: 'LEVEL'}), {
        description: message`Minify level: default or max`,
      }),
    ),
    noBytecode: optional(flag('--no-bytecode', {description: message`Skip bytecode compilation`})),
    timeout: optional(
      option('-t', '--timeout', string({metavar: 'MS'}), {
        description: message`Per-file timeout in ms (default: 60000)`,
      }),
    ),
    updateHeapSnapshots: optional(
      flag('-u', '--update-heap', {
        description: message`Overwrite committed heap snapshots (__heap_snapshots__/<chip>.json) with this run's per-test retained and peak figures and the device's boot figures. Drift under the tolerance is left alone.`,
      }),
    ),
    heapTolerance: optional(
      option('--heap-tolerance', string({metavar: 'SIZE'}), {
        description: message`Heap drift below which a snapshot is neither flagged nor rewritten (default: max(256, 1% of stored)). Accepts a K/M suffix.`,
      }),
    ),
    yes: optional(flag('-y', '--yes', {description: message`Skip confirmation prompt`})),
    isolate: optional(
      flag('--isolate', {
        description: message`Restart the device before every file so each starts from a fresh boot. Slower; removes any effect of run order on results and heap figures.`,
      }),
    ),
    diagnostics: optional(
      flag('--diagnostics', {
        description: message`Show per-test heap progress and other runtime diagnostics`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`NDJSON agent mode`})),
  }),
)
