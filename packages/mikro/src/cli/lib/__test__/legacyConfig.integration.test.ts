import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {discoverBoards} from '../boards.js'
import {getPredeployCommands} from '../runHooks.js'

// Verifies the legacy-key guard fires through the real config read paths,
// not just the unit (see legacyConfig.test.ts).
describe('legacy "mikrojs" config key is rejected at read sites', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(pathlib.join(tmpdir(), 'legacy-config-'))
  })

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true})
  })

  function writePkg(contents: object) {
    writeFileSync(pathlib.join(dir, 'package.json'), JSON.stringify(contents))
  }

  it('getPredeployCommands throws on a legacy "mikrojs" key', () => {
    writePkg({mikrojs: {predeploy: 'tsc'}})
    expect(() => getPredeployCommands(dir)).toThrow(
      /"mikrojs" config key in package\.json was renamed to "mikro"/,
    )
  })

  it('getPredeployCommands reads the new "mikro" key without throwing', () => {
    writePkg({mikro: {predeploy: 'tsc'}})
    expect(getPredeployCommands(dir)).toEqual(['tsc'])
  })

  it('discoverBoards throws on a legacy "mikrojs" key in the project package.json', async () => {
    writePkg({mikrojs: {boards: {}}})
    await expect(discoverBoards(dir)).rejects.toThrow(/"mikrojs" config key/)
  })
})
