import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag} from '@optique/core/primitives'

export const args = command(
  'list',
  object({
    subcommand: constant('list' as const),
    json: optional(flag('--json', {description: message`Output as JSON`})),
  }),
  {
    description: message`List the boards in boards.config.ts and their images, for example to build each image in a CI job of its own`,
  },
)
