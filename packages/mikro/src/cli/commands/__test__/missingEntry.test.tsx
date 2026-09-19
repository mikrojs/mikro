import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'
import {stripVTControlCharacters} from 'node:util'

import {parse} from '@optique/core/parser'
import {cleanup, render} from 'ink-testing-library'
import type {ReactElement} from 'react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {UserError} from '../../lib/errorMessage.js'
import Build, {args as buildArgs, run as buildRun} from '../build.js'
import Dev, {args as devArgs} from '../dev.js'
import SimDev, {args as simDevArgs} from '../sim/dev.js'

function parsed<T>(result: {success: true; value: T} | {success: false}): T {
  if (!result.success) throw new Error('Could not parse the command arguments')
  return result.value
}

// Every command that renders a terminal UI and resolves an entry. `dev` takes
// --port, whose value parser is async, so all three parse through parse().
const screens: [string, () => Promise<ReactElement>][] = [
  ['dev', async () => <Dev args={parsed(await parse(devArgs, ['dev']))} />],
  ['build', async () => <Build args={parsed(await parse(buildArgs, ['build']))} />],
  ['sim dev', async () => <SimDev args={parsed(await parse(simDevArgs, ['dev']))} />],
]

describe('a project without a "main" field', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = mkdtempSync(pathlib.join(tmpdir(), 'missing-entry-'))
    writeFileSync(pathlib.join(tempDir, 'package.json'), JSON.stringify({name: 'fixture'}))
    process.chdir(tempDir)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    process.chdir(originalCwd)
    rmSync(tempDir, {recursive: true, force: true})
  })

  it.each(screens)('mikro %s prints one line and exits 1', async (_, screen) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const {lastFrame} = render(await screen())
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))

    expect(stripVTControlCharacters(lastFrame() ?? '')).toBe(
      'Error: No entry file specified and package.json has no "main" field.\n' +
        'Either pass an entry file (e.g. mikro dev app/main.ts) or add a "main" field to package.json.',
    )
  })

  // Headless commands leave the reporting to runCommand, which prints the
  // message and exits 1 for a UserError.
  it('mikro build rejects with a UserError when it is not a terminal', async () => {
    await expect(buildRun(parsed(await parse(buildArgs, ['build'])))).rejects.toBeInstanceOf(
      UserError,
    )
  })
})
