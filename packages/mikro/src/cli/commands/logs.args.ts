import {command, constant, message, optional} from '@optique/core'
import {object as objectConstruct, or as orConstruct} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {port} from '../lib/portValueParser.js'

const portOption = optional(
  option('-p', '--port', port(), {
    description: message`Serial port of device`,
  }),
)

const pullArgs = command(
  'pull',
  objectConstruct({
    subcommand: constant('pull' as const),
    dest: optional(argument(string({metavar: 'DEST'}))),
    port: portOption,
  }),
)

const tailArgs = command(
  'tail',
  objectConstruct({
    subcommand: constant('tail' as const),
    port: portOption,
    restart: optional(flag('-r', '--restart', {description: message`Restart the device first`})),
    logLevel: optional(
      option('--loglevel', string({metavar: 'LEVEL'}), {
        description: message`Drop device output below this level: none, error, warn, info, debug (default: debug)`,
      }),
    ),
  }),
)

const resetArgs = command(
  'reset',
  objectConstruct({
    subcommand: constant('reset' as const),
    port: portOption,
  }),
)

export const args = command(
  'logs',
  objectConstruct({
    action: constant('logs'),
    sub: orConstruct(pullArgs, tailArgs, resetArgs),
  }),
)
