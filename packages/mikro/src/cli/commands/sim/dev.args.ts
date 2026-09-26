import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'

export const args = command(
  'dev',
  object({
    subcommand: constant('dev' as const),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
    forceDeploy: optional(
      flag('--force-deploy', {description: message`Force full deploy, ignoring cached checksums`}),
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
    noHooks: optional(
      flag('--no-hooks', {
        description: message`Skip mikro.predeploy hooks from package.json`,
      }),
    ),
    logLevel: optional(
      option('--loglevel', string({metavar: 'LEVEL'}), {
        description: message`Log level: none, error, warn, info, debug. Console calls below this level are eliminated at build time.`,
      }),
    ),
    env: optional(
      option('--env-file', path({metavar: 'FILE', type: 'file', mustExist: true}), {
        description: message`Path to .env file with environment variables`,
      }),
    ),
    noAutoEnv: optional(
      flag('--no-auto-env', {
        description: message`Skip auto-loading of .env and .env.simulator from the project root`,
      }),
    ),
    noWatch: optional(
      flag('--no-watch', {
        description: message`Deploy once, then drop into the REPL without watching for file changes`,
      }),
    ),
    agent: optional(flag('--agent', {description: message`NDJSON agent protocol over stdio`})),
  }),
  {description: message`Watch + build + deploy to simulator with REPL`},
)
