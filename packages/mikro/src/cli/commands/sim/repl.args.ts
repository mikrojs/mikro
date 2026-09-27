import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag} from '@optique/core/primitives'

export const args = command(
  'repl',
  object({
    subcommand: constant('repl' as const),
    agent: optional(flag('--agent', {description: message`NDJSON agent protocol over stdio`})),
  }),
  {description: message`Open an interactive REPL on the simulator`},
)
