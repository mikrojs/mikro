import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'

export const args = command('check', object({subcommand: constant('check' as const)}), {
  description: message`Check a board package's boards.config.ts, its "firmware" exports and their images before it is published`,
})
