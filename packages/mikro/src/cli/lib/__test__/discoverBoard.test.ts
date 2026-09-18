import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {genericBoards} from '../boards.js'
import {discoverBoard} from '../flashFirmware.js'

describe('genericBoards', () => {
  it('synthesizes one <chip>-generic board per supported chip', () => {
    const boards = genericBoards()
    expect(boards.length).toBeGreaterThan(0)
    for (const board of boards) {
      expect(board.name).toBe(`${board.chip}-generic`)
      expect(board.generic).toBe(true)
      expect(board.packageName).toBeUndefined()
    }
    expect(boards.map((b) => b.name)).toContain('esp32c6-generic')
  })
})

describe('discoverBoard', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    // A project with no board dependencies, so only generics resolve.
    tempDir = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'boards-')))
    writeFileSync(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', version: '0.0.0', type: 'module'}),
    )
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tempDir, {recursive: true, force: true})
  })

  it('returns undefined when nothing selects a board', async () => {
    expect(await discoverBoard(undefined)).toBeUndefined()
  })

  it('resolves a generic board from the --board flag', async () => {
    const resolved = await discoverBoard('esp32c6-generic')
    expect(resolved?.board.name).toBe('esp32c6-generic')
    expect(resolved?.board.chip).toBe('esp32c6')
    expect(resolved?.source).toBe('flag')
  })

  it('resolves a generic board from config.board when no flag is given', async () => {
    const resolved = await discoverBoard(undefined, 'esp32c6-generic')
    expect(resolved?.board.name).toBe('esp32c6-generic')
    expect(resolved?.source).toBe('config')
  })

  describe('with one board dependency', () => {
    beforeEach(() => {
      writeFileSync(
        pathlib.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'fixture',
          version: '0.0.0',
          type: 'module',
          dependencies: {'some-board': '1.0.0'},
        }),
      )
      const depDir = pathlib.join(tempDir, 'node_modules', 'some-board')
      mkdirSync(depDir, {recursive: true})
      writeFileSync(
        pathlib.join(depDir, 'package.json'),
        JSON.stringify({name: 'some-board', mikro: {boards: {'./devkit': {chip: 'esp32s3'}}}}),
      )
    })

    it('picks the dependency when nothing names a board', async () => {
      const resolved = await discoverBoard(undefined)
      expect(resolved?.board.name).toBe('devkit')
      expect(resolved?.source).toBe('dependency')
    })

    it('lets config.board win over the dependency', async () => {
      const resolved = await discoverBoard(undefined, 'esp32c6-generic')
      expect(resolved?.board.name).toBe('esp32c6-generic')
      expect(resolved?.source).toBe('config')
    })
  })

  it('rejects an unknown board with known boards and a suggestion', async () => {
    await expect(discoverBoard('esp32c6-generc')).rejects.toThrow(
      /Unknown board 'esp32c6-generc'\. Did you mean 'esp32c6-generic'\?\nKnown boards: .*esp32c6-generic/,
    )
  })
})
