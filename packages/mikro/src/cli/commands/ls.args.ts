import {command, constant, message, object, optional} from '@optique/core'
import {flag} from '@optique/core/primitives'

export const args = command(
  'ls',
  object({
    action: constant('list'),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
)
