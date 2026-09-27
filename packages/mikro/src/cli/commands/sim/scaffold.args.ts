import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag} from '@optique/core/primitives'

export const args = command(
  'scaffold',
  object({
    subcommand: constant('scaffold' as const),
    overwrite: optional(flag('--overwrite', {description: message`Overwrite existing stub files`})),
  }),
  {description: message`Generate simulator stub files for hardware builtins in sim/`},
)
