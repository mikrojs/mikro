import {command, constant, message} from '@optique/core'
import {object as objectConstruct, or as orConstruct} from '@optique/core/constructs'

import {args as enrollArgs} from './ota/enroll.args.js'
import {args as packArgs} from './ota/pack.args.js'
import {args as pushArgs} from './ota/push.args.js'
import {args as releaseArgs} from './ota/release.args.js'
import {args as setupArgs} from './ota/setup.args.js'

export const args = command(
  'ota',
  objectConstruct({
    action: constant('ota'),
    sub: orConstruct(packArgs, pushArgs, enrollArgs, setupArgs, releaseArgs),
  }),
  {description: message`Build, publish, and release app builds for over-the-air updates`},
)
