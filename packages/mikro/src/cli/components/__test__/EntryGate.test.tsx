import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'
import {stripVTControlCharacters} from 'node:util'

import {Text} from 'ink'
import {cleanup, render} from 'ink-testing-library'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {EntryGate} from '../EntryGate.js'

describe('EntryGate', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = mkdtempSync(pathlib.join(tmpdir(), 'EntryGate-'))
    writeFileSync(pathlib.join(tempDir, 'package.json'), JSON.stringify({name: 'test'}))
    process.chdir(tempDir)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    process.chdir(originalCwd)
    rmSync(tempDir, {recursive: true, force: true})
  })

  it('renders its children with the resolved entry', () => {
    const {lastFrame} = render(
      <EntryGate entry="app/main.ts">{(entry) => <Text>{entry}</Text>}</EntryGate>,
    )

    expect(lastFrame()).toBe('app/main.ts')
  })

  it('prints a missing entry without a stack trace and exits 1', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const {lastFrame} = render(<EntryGate entry={undefined}>{() => <Text>built</Text>}</EntryGate>)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))

    expect(stripVTControlCharacters(lastFrame() ?? '')).toBe(
      'Error: No entry file specified and package.json has no "main" field.\n' +
        'Either pass an entry file (e.g. mikro dev app/main.ts) or add a "main" field to package.json.',
    )
  })

  it('reports why package.json could not be read', async () => {
    writeFileSync(pathlib.join(tempDir, 'package.json'), '{"main": }')
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const {lastFrame} = render(<EntryGate entry={undefined}>{() => <Text>built</Text>}</EntryGate>)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))

    const frame = stripVTControlCharacters(lastFrame() ?? '')
    expect(frame).toContain('package.json is not valid JSON')
    expect(frame).toContain('JSON')
    expect(frame).not.toContain(' at ')
  })
})
