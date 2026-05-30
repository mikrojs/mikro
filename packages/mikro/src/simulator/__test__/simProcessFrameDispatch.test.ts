/**
 * Asserts every CMD_* the CLI sends has a `case CMD_*:` branch in
 * simProcess.ts's frame dispatcher.
 *
 * Regression: CMD_RUNTIME_PAUSE / CMD_RUNTIME_RESUME were added to the wire
 * protocol and emitted by `session.ts` deploys, but the simulator subprocess
 * dispatcher was never updated, so `mikro sim dev` timed out for 10s on every
 * deploy waiting for an MSG_OK that never came.
 */
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {describe, expect, it} from 'vitest'

import * as proto from '../../cli/lib/protocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const simProcessSource = readFileSync(join(__dirname, '../simProcess.ts'), 'utf-8')

const cmdNames = Object.keys(proto).filter((k) => k.startsWith('CMD_'))

describe('simProcess frame dispatch', () => {
  for (const name of cmdNames) {
    it(`dispatches ${name}`, () => {
      const re = new RegExp(`case\\s+${name}\\s*:`)
      expect(re.test(simProcessSource), `${name} has no case branch in simProcess.ts`).toBe(true)
    })
  }
})
