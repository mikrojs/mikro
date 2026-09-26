import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

export const args = command(
  'release',
  object({
    subcommand: constant('release' as const),
    version: argument(string({metavar: 'VERSION'})),
    channel: argument(string({metavar: 'CHANNEL'})),
    registry: optional(
      option('--registry', string({metavar: 'URL'}), {
        description: message`Registry base URL (default: .mikro/registry.json)`,
      }),
    ),
    token: optional(
      option('--token', string({metavar: 'TOKEN'}), {
        description: message`Registry auth token (default: MIKRO_OTA_TOKEN or .mikro/registry.json)`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
  {description: message`Point a channel at an already-pushed build`},
)
