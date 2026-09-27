import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'

export const args = command(
  'docs',
  object({
    action: constant('docs'),
  }),
  {description: message`Open the documentation in your browser`},
)
