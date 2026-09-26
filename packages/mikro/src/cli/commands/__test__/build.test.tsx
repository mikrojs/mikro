import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {type InferValue, parseSync} from '@optique/core/parser'
import {render} from 'ink-testing-library'
import React from 'react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import Build, {args, run} from '../build.js'

type Args = InferValue<typeof args>

// Parse after the chdir: the entry argument must exist.
function parseArgs(argv = ['app/main.ts', '-o', 'out']): Args {
  const result = parseSync(args, ['build', ...argv, '--no-bytecode'])
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

// Runs each test in a fresh project whose package.json names app/main.ts as "main".
function useFixtureProject() {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'build-command-')))
    process.chdir(tempDir)
    writeFileSync(
      'package.json',
      JSON.stringify({name: 'fixture', version: '0.0.0', type: 'module', main: 'app/main.ts'}),
    )
    mkdirSync('app')
    writeFileSync(pathlib.join('app', 'main.ts'), "console.log('hi')\n")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.chdir(originalCwd)
    rmSync(tempDir, {recursive: true, force: true})
  })
}

describe.each(Object.entries(modes))('mikro build (%s)', (_mode, mikroBuild) => {
  useFixtureProject()

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

  it('writes to .mikro/build in the project root by default', async () => {
    await mikroBuild(parseArgs(['app/main.ts']))
    expect(existsSync(pathlib.join('.mikro', 'build', 'app', 'main.js'))).toBe(true)
    expect(existsSync('build')).toBe(false)
  })

  it('takes --out-dir without an entry', async () => {
    await mikroBuild(parseArgs(['-o', 'out']))
    expect(existsSync(pathlib.join('out', 'app', 'main.js'))).toBe(true)
  })
})

describe('mikro build --json', () => {
  useFixtureProject()

  it('reports outDir as an absolute path and leaves out the marker', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await run({...parseArgs(['-o', 'out']), json: true})
    const {result} = JSON.parse(String(write.mock.calls.at(-1)?.[0]))
    expect(result.outDir).toBe(pathlib.resolve('out'))
    expect(result.files.map((f: {path: string}) => f.path)).not.toContain('/.mikro-build')
  })
})
