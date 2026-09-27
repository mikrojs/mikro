import {FULL_IMAGE} from '@mikrojs/firmware/boards'
import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag} from '@optique/core/primitives'

import {agentResult, isAgentMode} from '../../lib/agent.js'
import {configuredPackage, noBoardsConfig} from './build.js'
import {failFw} from './shared.js'

export const args = command(
  'list',
  object({
    subcommand: constant('list' as const),
    json: optional(flag('--json', {description: message`Output as JSON`})),
  }),
  {
    description: message`List the boards in boards.config.ts and their images, for example to build each image in a CI job of its own`,
  },
)

type Args = InferValue<typeof args>

export async function run(config: Args): Promise<void> {
  const jsonOutput = config.json === true || isAgentMode()
  try {
    const configured = await configuredPackage(process.cwd())
    if (configured === undefined) throw noBoardsConfig(process.cwd())
    const boards = configured.boards.map(({name, chip, images}) => ({
      name,
      chip,
      images: [FULL_IMAGE, ...images.map((image) => image.name)],
    }))
    if (jsonOutput) {
      agentResult('fw list', {boards})
      return
    }
    for (const board of boards) {
      // eslint-disable-next-line no-console
      console.log(`${board.name} (${board.chip}): ${board.images.join(', ')}`)
    }
  } catch (err) {
    failFw('fw list', err, jsonOutput)
  }
}
