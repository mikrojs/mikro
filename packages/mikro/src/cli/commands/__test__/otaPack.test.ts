import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {UserError} from '../../lib/errorMessage.js'
import {packProject} from '../ota/pack.js'

describe('packProject', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = mkdtempSync(pathlib.join(tmpdir(), 'ota-pack-'))
    mkdirSync(pathlib.join(tempDir, 'app'))
    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), 'export const a = 1\n')
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tempDir, {recursive: true, force: true})
  })

  function writePackageJson(version: string) {
    writeFileSync(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', version, main: 'app/main.ts'}),
    )
  }

  it('refuses a version longer than the registry and devices accept', async () => {
    writePackageJson(`1.0.0-${'a'.repeat(59)}`)
    const packed = packProject({})
    await expect(packed).rejects.toThrow(UserError)
    await expect(packed).rejects.toThrow(/at most 64/)
  })

  it('refuses a base version that --snapshot makes too long', async () => {
    // 39 characters fit; the 26 that --snapshot adds do not.
    writePackageJson(`1.0.0-${'a'.repeat(33)}`)
    await expect(packProject({snapshot: true})).rejects.toThrow(/at most 64/)
  })
})
