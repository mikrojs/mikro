import {command, constant, message, or} from '@optique/core'
import {object} from '@optique/core/constructs'

import {args as buildArgs} from './fw/build.args.js'
import {args as checkArgs} from './fw/check.args.js'
import {args as listArgs} from './fw/list.args.js'
import {args as packArgs} from './fw/pack.args.js'

export const args = command(
  'fw',
  object({
    action: constant('fw'),
    sub: or(packArgs, buildArgs, checkArgs, listArgs),
  }),
  {description: message`Build, pack, check and list board images and custom firmware builds`},
)
