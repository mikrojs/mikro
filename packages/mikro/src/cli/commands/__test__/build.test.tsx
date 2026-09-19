import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {type InferValue, parseSync} from '@optique/core/parser'
import {render} from 'ink-testing-library'
import React from 'react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import Build, {args, run} from '../build.js'

type Args = InferValue<typeof args>

// Parse after the chdir: the entry argument must exist.
function parseArgs(): Args {
  const result = parseSync(args, ['build', 'app/main.ts', 'out', '--no-bytecode'])
  if (!result.success) throw new Error('Could not parse the build arguments')
  return result.value
}

// A terminal renders <Build>; --json, --agent and piped runs call run().
const modes: Record<string, (config: Args) => Promise<void>> = {
  terminal: async (config) => {
    const exitCode = new Promise((resolve) => {
      vi.spyOn(process, 'exit').mockImplementation((code) => {
        resolve(code)
        return undefined as never
      })
    })
    const app = render(<Build args={config} />)
    const code = await exitCode
    app.cleanup()
    expect(code).toBe(0)
  },
  json: async (config) => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await run({...config, json: true})
  },
}

describe.each(Object.entries(modes))('mikro build (%s)', (_mode, mikroBuild) => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'build-command-')))
    process.chdir(tempDir)
    writeFileSync(
      'package.json',
      JSON.stringify({name: 'fixture', version: '0.0.0', type: 'module'}),
    )
    mkdirSync('app')
    writeFileSync(pathlib.join('app', 'main.ts'), "console.log('hi')\n")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.chdir(originalCwd)
    rmSync(tempDir, {recursive: true, force: true})
  })

  const builtMain = () => readFileSync(pathlib.join('out', 'app', 'main.js'), 'utf-8')

  it('drops console.log by default', async () => {
    await mikroBuild(parseArgs())
    expect(builtMain()).not.toContain('console.log')
  })

  it('keeps console.log when mikro.config.ts sets build.logLevel', async () => {
    writeFileSync('mikro.config.ts', "export default {build: {logLevel: 'debug'}}\n")
    await mikroBuild(parseArgs())
    expect(builtMain()).toContain('console.log')
  })
})
