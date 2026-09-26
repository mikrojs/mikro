import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import {passThrough} from '@optique/core/primitives'

export const args = command(
  'idf',
  object({
    action: constant('idf'),
    args: passThrough({format: 'greedy', description: message`Arguments for idf.py`}),
  }),
  {
    description: message`Run ESP-IDF's idf.py to build custom firmware, with the build in .mikro/build-fw (.mikro/build-fw-<folder> for a project in a folder of the package)`,
  },
)
