import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag} from '@optique/core/primitives'

export const args = command(
  'reset',
  object({
    subcommand: constant('reset' as const),
    yes: optional(flag('-y', '--yes', {description: message`Skip confirmation prompt`})),
  }),
  {
    description: message`Erase the entire simulator state (filesystem + environment variables)`,
  },
)
