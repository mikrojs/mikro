import {FULL_IMAGE} from '@mikrojs/firmware/boards'
import type {InferValue} from '@optique/core/parser'

import {agentResult, isAgentMode} from '../../lib/agent.js'
import {configuredPackage, noBoardsConfig} from './build.js'
import type {args} from './list.args.js'
import {failFw} from './shared.js'

type Args = InferValue<typeof args>

export async function run(config: Args): Promise<void> {
  const jsonOutput = config.json === true || isAgentMode()
  try {
    const configured = await configuredPackage(process.cwd())
    if (configured === undefined) throw noBoardsConfig(process.cwd())
    const boards = [
      ...configured.boards.map(({name, chip, images}) => ({
        name,
        chip,
        images: [FULL_IMAGE, ...images.map((image) => image.name)],
      })),
      // Nothing to build: they run a generic image
      ...configured.generic.map(({name, chip, firmware}) => ({name, chip, firmware, images: []})),
    ]
    if (jsonOutput) {
      agentResult('fw list', {boards})
      return
    }
    for (const board of boards) {
      // eslint-disable-next-line no-console
      console.log(
        'firmware' in board
          ? `${board.name} (${board.chip}): runs ${board.firmware}`
          : `${board.name} (${board.chip}): ${board.images.join(', ')}`,
      )
    }
  } catch (err) {
    failFw('fw list', err, jsonOutput)
  }
}
