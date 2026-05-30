import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {resolveEntry} from '../resolveEntry.js'

describe('resolveEntry', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = mkdtempSync(pathlib.join(tmpdir(), 'resolveEntry-'))
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tempDir, {recursive: true, force: true})
  })

  it('returns explicit entry as-is', () => {
    expect(resolveEntry('app/main.ts')).to.equal('app/main.ts')
  })

  it('resolves main field from package.json when entry is undefined', () => {
    writeFileSync(pathlib.join(tempDir, 'package.json'), JSON.stringify({main: './app/main.ts'}))
    mkdirSync(pathlib.join(tempDir, 'app'))
    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), '')
    process.chdir(tempDir)

    expect(resolveEntry(undefined)).to.equal('app/main.ts')
  })

  it('resolves main field without leading ./', () => {
    writeFileSync(pathlib.join(tempDir, 'package.json'), JSON.stringify({main: 'src/index.js'}))
    mkdirSync(pathlib.join(tempDir, 'src'))
    writeFileSync(pathlib.join(tempDir, 'src', 'index.js'), '')
    process.chdir(tempDir)

    expect(resolveEntry(undefined)).to.equal('src/index.js')
  })

  it('throws when no entry and no package.json', () => {
    process.chdir(tempDir)

    expect(() => resolveEntry(undefined)).to.throw(
      /No entry file specified and no package\.json found/,
    )
  })

  it('throws when no entry and package.json has no main field', () => {
    writeFileSync(pathlib.join(tempDir, 'package.json'), JSON.stringify({name: 'test'}))
    process.chdir(tempDir)

    expect(() => resolveEntry(undefined)).to.throw(/package\.json has no "main" field/)
  })

  it('throws when main field points to non-existent file', () => {
    writeFileSync(pathlib.join(tempDir, 'package.json'), JSON.stringify({main: './app/missing.ts'}))
    process.chdir(tempDir)

    expect(() => resolveEntry(undefined)).to.throw(/does not exist/)
  })
})
