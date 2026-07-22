import {command, constant, message} from '@optique/core'
import {object as objectConstruct, or as orConstruct} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'

import * as enrollSub from './ota/enroll.js'
import * as packSub from './ota/pack.js'
import * as publishSub from './ota/publish.js'
import * as setupSub from './ota/setup.js'

export const args = command(
  'ota',
  objectConstruct({
    action: constant('ota'),
    sub: orConstruct(packSub.args, publishSub.args, enrollSub.args, setupSub.args),
  }),
  {description: message`Pack and publish app builds for over-the-air updates`},
)

type Args = InferValue<typeof args>

export async function run(config: Args): Promise<void> {
  const sub = config.sub
  switch (sub.subcommand) {
    case 'pack':
      await packSub.run(sub)
      break
    case 'publish':
      await publishSub.run(sub)
      break
    case 'enroll':
      await enrollSub.run(sub)
      break
    case 'setup':
      await setupSub.run(sub)
      break
  }
}
