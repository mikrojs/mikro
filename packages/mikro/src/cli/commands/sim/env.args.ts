import {command, constant, message, optional} from '@optique/core'
import {object as objectConstruct, or as orConstruct} from '@optique/core/constructs'
import {argument, flag} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

const jsonFlag = optional(flag('--json', {description: message`Output as JSON`}))
const agentFlag = optional(flag('--agent', {description: message`Output as JSON (agent mode)`}))

const listArgs = command(
  'list',
  objectConstruct({
    envSubcommand: constant('list' as const),
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const getArgs = command(
  'get',
  objectConstruct({
    envSubcommand: constant('get' as const),
    key: argument(string({metavar: 'KEY'})),
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const setArgs = command(
  'set',
  objectConstruct({
    envSubcommand: constant('set' as const),
    noSecret: optional(
      flag('--no-secret', {
        description: message`Pass VALUE as an argument and store it as non-secret (visible in 'env list')`,
      }),
    ),
    key: argument(string({metavar: 'KEY'})),
    value: optional(argument(string({metavar: 'VALUE'}))),
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const deleteArgs = command(
  'delete',
  objectConstruct({
    envSubcommand: constant('delete' as const),
    key: argument(string({metavar: 'KEY'})),
    json: jsonFlag,
    agent: agentFlag,
  }),
)

export const args = command(
  'env',
  objectConstruct({
    subcommand: constant('env' as const),
    envSub: orConstruct(listArgs, getArgs, setArgs, deleteArgs),
  }),
  {description: message`Manage environment variables stored in the simulator`},
)
