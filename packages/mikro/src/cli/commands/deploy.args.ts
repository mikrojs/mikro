import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'

import {port} from '../lib/portValueParser.js'

export const args = command(
  'deploy',
  object({
    action: constant('deploy'),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
    port: optional(
      option('-p', '--port', port(), {
        description: message`Serial port of device to deploy to`,
      }),
    ),
    console: optional(
      flag('--console', {
        description: message`Attach console after deploy and restart device`,
      }),
    ),
    env: optional(
      option('--env-file', path({metavar: 'FILE', type: 'file', mustExist: true}), {
        description: message`Path to .env file with environment variables`,
      }),
    ),
    noAutoEnv: optional(
      flag('--no-auto-env', {
        description: message`Skip auto-loading of .env and .env.production from the project root`,
      }),
    ),
    noRestart: optional(
      flag('--no-restart', {
        description: message`Stage the build without restarting; it installs at the next device boot`,
      }),
    ),
    recover: optional(
      flag('--recover', {
        description: message`Reset the device into safe mode before deploying. Use when the deployed app is crash-looping.`,
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
    yes: optional(
      flag('-y', '--yes', {
        description: message`If the device firmware is incompatible, flash CLI-matched firmware without prompting`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
)
