import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'

export const args = command(
  'clean',
  object({
    subcommand: constant('clean' as const),
  }),
  {description: message`Remove the deployed app from the simulator`},
)
