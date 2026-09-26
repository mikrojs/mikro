import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'

import * as packSub from './fw/pack.js'

export const args = command(
  'fw',
  object({
    action: constant('fw'),
    sub: packSub.args,
  }),
  {description: message`Pack custom firmware builds`},
)

export async function run(config: InferValue<typeof args>): Promise<void> {
  await packSub.run(config.sub)
}
