import {command, constant, message, optional} from '@optique/core'
import {object, or} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {port} from '../lib/portValueParser.js'

const jsonFlag = optional(flag('--json', {description: message`Output as JSON`}))
const agentFlag = optional(flag('--agent', {description: message`Output as JSON (agent mode)`}))
const portOption = optional(
  option('-p', '--port', port(), {
    description: message`Device to act on (path, serial, or name). Defaults to the only connected device.`,
  }),
)

const showArgs = command(
  'show',
  object({
    subcommand: constant('show' as const),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const setArgs = command(
  'set',
  object({
    subcommand: constant('set' as const),
    // Optional: with no NAME we materialize the one derived from the device id.
    name: optional(argument(string({metavar: 'NAME'}))),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const unsetArgs = command(
  'unset',
  object({
    subcommand: constant('unset' as const),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

export const args = command(
  'name',
  object({
    action: constant('name'),
    // Optional so bare `mikro name` works; it defaults to `show` below.
    sub: optional(or(showArgs, setArgs, unsetArgs)),
  }),
  {description: message`Show or set the connected device's name`},
)
