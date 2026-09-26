import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'

export const args = command(
  'home',
  object({
    action: constant('home'),
  }),
  {description: message`Open the mikrojs website in your browser`},
)
