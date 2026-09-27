import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

export const args = command(
  'setup',
  object({
    subcommand: constant('setup' as const),
    registry: optional(
      option('--registry', string({metavar: 'URL'}), {
        description: message`Registry base URL (skips the url prompt)`,
      }),
    ),
    token: optional(
      option('--token', string({metavar: 'TOKEN'}), {
        description: message`Registry token (skips the token prompt; with --registry, setup runs without prompts)`,
      }),
    ),
    user: optional(
      flag('--user', {
        description: message`Write ~/.mikro/registry.json (all projects) instead of the project's .mikro/registry.json`,
      }),
    ),
    force: optional(
      flag('--force', {
        description: message`Configure the url even if it does not identify as a Mikro.js registry`,
      }),
    ),
  }),
  {description: message`Configure which update registry to use (url and token)`},
)
