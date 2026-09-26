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

const jsonFlag = optional(flag('--json', {description: message`Output as JSON`}))
const agentFlag = optional(flag('--agent', {description: message`Output as JSON (agent mode)`}))

const listArgs = command(
  'list',
  objectConstruct({
    subcommand: constant('list' as const),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const setArgs = command(
  'set',
  objectConstruct({
    subcommand: constant('set' as const),
    noSecret: optional(
      flag('--no-secret', {
        description: message`Pass VALUE as an argument and store it as non-secret (visible in 'env list')`,
      }),
    ),
    key: argument(string({metavar: 'KEY'})),
    value: optional(argument(string({metavar: 'VALUE'}))),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const deleteArgs = command(
  'delete',
  objectConstruct({
    subcommand: constant('delete' as const),
    key: argument(string({metavar: 'KEY'})),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const uiArgs = command(
  'ui',
  objectConstruct({
    subcommand: constant('ui' as const),
    port: portOption,
  }),
)

export const args = command(
  'env',
  objectConstruct({
    action: constant('env'),
    sub: orConstruct(listArgs, setArgs, deleteArgs, uiArgs),
  }),
)
