import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {projectNameProblem, targetDirProblem} from './folder.js'

describe('where a project can go', () => {
  let cwd: string

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'create-mikro-test-folder-')))
  })

  afterEach(() => {
    rmSync(cwd, {recursive: true, force: true})
  })

  it('takes a new folder, an empty one, and the cwd without a package.json', () => {
    mkdirSync(path.join(cwd, 'empty'))
    expect(targetDirProblem('new', cwd, false)).toBeUndefined()
    expect(targetDirProblem('empty', cwd, false)).toBeUndefined()
    expect(targetDirProblem('.', cwd, false)).toBeUndefined()
  })

  it('names what is in the way', () => {
    mkdirSync(path.join(cwd, 'taken'))
    writeFileSync(path.join(cwd, 'taken', 'file'), '')
    writeFileSync(path.join(cwd, 'README.md'), '')
    expect(targetDirProblem('taken', cwd, false)).toBe(
      'Directory "taken" already exists and is not empty.',
    )
    // A file by that name, or a path through one, is refused rather than thrown
    expect(targetDirProblem('README.md', cwd, false)).toContain('a file is in the way')
    expect(targetDirProblem('README.md/app', cwd, false)).toContain('a file is in the way')

    writeFileSync(path.join(cwd, 'package.json'), '{}')
    expect(targetDirProblem('.', cwd, false)).toBe(
      'Current directory already contains a package.json.',
    )
  })

  it('refuses a path with spaces only for what ESP-IDF builds', () => {
    expect(targetDirProblem('My App', cwd, false)).toBeUndefined()
    expect(targetDirProblem('My App', cwd, true)).toContain(
      "ESP-IDF can't build in a path with spaces",
    )
  })

  describe('at the name prompt', () => {
    it('answers a taken folder, so another name can be typed', () => {
      mkdirSync(path.join(cwd, 'taken'))
      writeFileSync(path.join(cwd, 'taken', 'file'), '')
      expect(projectNameProblem('taken', 'my-app', cwd, false)).toBe(
        'Directory "taken" already exists and is not empty.',
      )
      expect(projectNameProblem('free', 'my-app', cwd, false)).toBeUndefined()
    })

    it('takes the default for an empty line, and checks that folder too', () => {
      expect(projectNameProblem('', 'my-app', cwd, false)).toBeUndefined()
      expect(projectNameProblem('  ', 'my-app', cwd, false)).toBeUndefined()
      mkdirSync(path.join(cwd, 'my-app'))
      writeFileSync(path.join(cwd, 'my-app', 'file'), '')
      expect(projectNameProblem('', 'my-app', cwd, false)).toBe(
        'Directory "my-app" already exists and is not empty.',
      )
    })

    it('asks for a name when nothing usable was typed', () => {
      expect(projectNameProblem('???', 'my-app', cwd, false)).toBe('Project name is required')
    })
  })
})
