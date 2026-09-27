import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import type {ConfiguredBoard} from '@mikrojs/firmware/boards'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {loadBoardsConfig, selectBoards, writeBoardProject} from '../boardsConfig.js'

let dir: string

function write(file: string, content: string) {
  mkdirSync(pathlib.dirname(file), {recursive: true})
  writeFileSync(file, content)
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'boards-config-')))
})

afterEach(() => {
  rmSync(dir, {recursive: true, force: true})
})

describe('loadBoardsConfig', () => {
  it('loads boards.config.ts with defineBoards and relative imports', async () => {
    write(
      pathlib.join(dir, 'package.json'),
      JSON.stringify({name: 'devboard', exports: {'.': {firmware: './dist-fw/firmware.json'}}}),
    )
    write(pathlib.join(dir, 'chip.ts'), `export const chip: string = 'esp32c6'\n`)
    write(
      pathlib.join(dir, 'boards.config.ts'),
      [
        `import {defineBoards} from 'mikro'`,
        `import {chip} from './chip.js'`,
        `export default defineBoards({boards: {'.': {chip}}} as const)`,
      ].join('\n'),
    )

    const loaded = await loadBoardsConfig(dir)

    expect(loaded?.problems).toEqual([])
    expect(loaded?.boards.map((b) => [b.name, b.chip])).toEqual([['devboard', 'esp32c6']])
  })

  it('is undefined for a package without one', async () => {
    write(pathlib.join(dir, 'package.json'), '{"name": "app"}')
    expect(await loadBoardsConfig(dir)).toBeUndefined()
  })
})

function board(fields: Partial<ConfiguredBoard> = {}): ConfiguredBoard {
  return {
    key: './t-display',
    specifier: '@acme/boards/t-display',
    name: '@acme/boards/t-display',
    chip: 'esp32',
    sdkconfig: [],
    nativeModules: [],
    target: './dist-fw/t-display/firmware.json',
    imageDir: pathlib.join(dir, 'dist-fw', 't-display'),
    ...fields,
  }
}

describe('writeBoardProject', () => {
  it('names the board in the generated CMakeLists.txt, quoted for CMake', async () => {
    const project = await writeBoardProject(
      dir,
      board({description: 'LILYGO "T-Display" ${x} \\ 1.14"', nativeModules: ['@a/b', '#c']}),
    )
    const cmake = readFileSync(pathlib.join(project, 'CMakeLists.txt'), 'utf8')
    expect(cmake).toContain('set(MIKROJS_BOARD_NAME "@acme/boards/t-display")')
    expect(cmake).toContain(
      'set(MIKROJS_BOARD_DESCRIPTION "LILYGO \\"T-Display\\" \\${x} \\\\ 1.14\\"")',
    )
    expect(cmake).toContain('set(MIKROJS_NATIVE_MODULES "@a/b;#c")')
  })

  it("writes the board's settings and partition table next to the generated project", async () => {
    write(pathlib.join(dir, 'a.defaults'), 'CONFIG_A=y')
    write(pathlib.join(dir, 'b.defaults'), 'CONFIG_B=y')
    write(pathlib.join(dir, 'p.csv'), 'nvs, data, nvs, , 0x6000')

    const project = await writeBoardProject(
      dir,
      board({
        sdkconfig: [pathlib.join(dir, 'a.defaults'), pathlib.join(dir, 'b.defaults')],
        partitions: pathlib.join(dir, 'p.csv'),
      }),
    )

    expect(project).toBe(pathlib.join(dir, '.mikro', 'fw-t-display'))
    const defaults = readFileSync(pathlib.join(project, 'sdkconfig.defaults'), 'utf8')
    expect(defaults.indexOf('CONFIG_A=y')).toBeLessThan(defaults.indexOf('CONFIG_B=y'))
    expect(readFileSync(pathlib.join(project, 'partitions.csv'), 'utf8')).toContain('nvs')

    // Without a partition table of its own, the firmware's applies
    await writeBoardProject(dir, board())
    expect(existsSync(pathlib.join(project, 'partitions.csv'))).toBe(false)
  })

  it("drops sdkconfig when @mikrojs/firmware's own defaults change", async () => {
    const project = await writeBoardProject(dir, board(), 'CONFIG_X=y')
    const sdkconfig = pathlib.join(project, 'sdkconfig')
    write(sdkconfig, 'CONFIG_IDF_TARGET="esp32"\n')

    await writeBoardProject(dir, board(), 'CONFIG_X=y')
    expect(existsSync(sdkconfig)).toBe(true)
    await writeBoardProject(dir, board(), 'CONFIG_X=n')
    expect(existsSync(sdkconfig)).toBe(false)
  })

  it('keeps sdkconfig while the settings stay the same, and drops it when they change', async () => {
    write(pathlib.join(dir, 'a.defaults'), 'CONFIG_A=y')
    const withA = board({sdkconfig: [pathlib.join(dir, 'a.defaults')]})
    const project = await writeBoardProject(dir, withA)
    const sdkconfig = pathlib.join(project, 'sdkconfig')
    write(sdkconfig, 'CONFIG_IDF_TARGET="esp32"\n')
    const cmake = statSync(pathlib.join(project, 'CMakeLists.txt')).mtimeMs

    await writeBoardProject(dir, withA)
    expect(existsSync(sdkconfig)).toBe(true)
    expect(statSync(pathlib.join(project, 'CMakeLists.txt')).mtimeMs).toBe(cmake)

    write(pathlib.join(dir, 'a.defaults'), 'CONFIG_A=n')
    await writeBoardProject(dir, withA)
    expect(existsSync(sdkconfig)).toBe(false)
  })

  it('starts over for a new chip: no sdkconfig, no build folder', async () => {
    const project = await writeBoardProject(dir, board())
    write(pathlib.join(project, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32"\n')
    const buildDir = pathlib.join(dir, '.mikro', 'build-fw-t-display')
    write(pathlib.join(buildDir, 'CMakeCache.txt'), 'IDF_TARGET:STRING=esp32\n')

    await writeBoardProject(dir, board({chip: 'esp32s3'}))

    expect(existsSync(pathlib.join(project, 'sdkconfig'))).toBe(false)
    expect(existsSync(buildDir)).toBe(false)
  })
})

describe('selectBoards', () => {
  const two = () => [
    board(),
    board({key: './devkit', specifier: '@acme/boards/devkit', name: 'devkit'}),
  ]

  it('picks by key, key without ./, or name, and all without a selector', () => {
    const boards = two()
    expect(selectBoards(boards, undefined)).toHaveLength(2)
    expect(selectBoards(boards, './devkit').map((b) => b.key)).toEqual(['./devkit'])
    expect(selectBoards(boards, 't-display').map((b) => b.key)).toEqual(['./t-display'])
    expect(selectBoards(boards, 'devkit').map((b) => b.key)).toEqual(['./devkit'])
  })

  it('lists the boards when none matches', () => {
    expect(() => selectBoards(two(), 'nope')).toThrow(
      'boards.config.ts has no board "nope". Its boards:\n  ./t-display (@acme/boards/t-display)\n  ./devkit (devkit)',
    )
  })
})
