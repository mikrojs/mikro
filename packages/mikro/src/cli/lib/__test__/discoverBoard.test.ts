import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {chips} from '@mikrojs/firmware'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {bundledBoards, discoverBoards, staleImage} from '../boards.js'
import {loadBoardsConfig} from '../boardsConfig.js'
import {bundledBoardsDir} from '../bundledImages.js'
import {type BoardDiscovery, discoverBoard} from '../flashFirmware.js'

describe('bundledBoards', () => {
  it('has one <chip>-generic board per supported chip', () => {
    const boards = bundledBoards()
    expect(boards.length).toBeGreaterThan(0)
    for (const board of boards) {
      expect(board.name).toBe(`${board.chip}-generic`)
      expect(board.bundled).toBe(true)
    }
    expect(boards.map((b) => b.name)).toContain('esp32c6-generic')
  })

  it("come from mikro's own boards.config.ts, one per chip, as its exports declare", async () => {
    const loaded = await loadBoardsConfig(pathlib.join(import.meta.dirname, '..', '..', '..', '..'))
    expect(loaded?.problems).toEqual([])
    expect(loaded?.boards.map((b) => [b.key, b.name, b.chip])).toEqual(
      chips.map((chip) => [`./${chip}-generic`, `${chip}-generic`, chip]),
    )
  })
})

function write(file: string, content: string) {
  mkdirSync(pathlib.dirname(file), {recursive: true})
  writeFileSync(file, content)
}

/** A board image as `mikro fw prepack` writes it. */
function writeImage(dir: string, firmware: Record<string, unknown>) {
  write(pathlib.join(dir, 'firmware.json'), JSON.stringify({version: '0.21.0', ...firmware}))
  write(
    pathlib.join(dir, 'flasher_args.json'),
    JSON.stringify({
      flash_files: {'0x10000': 'mikrojs.bin'},
      app: {offset: '0x10000', file: 'mikrojs.bin'},
      flash_settings: {flash_mode: 'dio', flash_size: '4MB', flash_freq: '80m'},
      extra_esptool_args: {chip: firmware.chip},
    }),
  )
  write(pathlib.join(dir, 'mikrojs.bin'), 'app')
}

/** A single-board package `c6-neo` and a multi-board `@fx/boards` with two boards,
 *  the first with the build `mikro fw prepack` leaves. */
function installBoards(dir: string) {
  const neo = pathlib.join(dir, 'node_modules/c6-neo')
  write(
    pathlib.join(neo, 'package.json'),
    JSON.stringify({name: 'c6-neo', exports: {'.': {firmware: './dist-fw/firmware.json'}}}),
  )
  writeImage(pathlib.join(neo, 'dist-fw'), {
    name: 'c6-neo',
    chip: 'esp32c6',
    description: 'ring board',
  })
  const fx = pathlib.join(dir, 'node_modules/@fx/boards')
  write(
    pathlib.join(fx, 'package.json'),
    JSON.stringify({
      name: '@fx/boards',
      exports: {
        './b1': {firmware: './dist-fw/b1/firmware.json', default: './dist/b1.js'},
        './b2': {firmware: './dist-fw/b2/firmware.json'},
        './pins': './dist/pins.js',
      },
    }),
  )
  writeImage(pathlib.join(fx, 'dist-fw/b1'), {name: '@fx/boards/b1', chip: 'esp32s3'})
  mkdirSync(pathlib.join(fx, '.mikro/build-fw-b1'), {recursive: true})
  writeImage(pathlib.join(fx, 'dist-fw/b2'), {name: '@fx/boards/b2', chip: 'esp32'})
}

describe('discoverBoards', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'boards-')))
  })

  afterEach(() => {
    rmSync(tempDir, {recursive: true, force: true})
  })

  it("reads each dependency's firmware exports", async () => {
    write(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', dependencies: {'c6-neo': '*', '@fx/boards': '*'}}),
    )
    installBoards(tempDir)
    const {boards, problems} = await discoverBoards(tempDir)
    expect(problems).toEqual([])
    expect(boards).toEqual([
      {
        name: 'c6-neo',
        chip: 'esp32c6',
        description: 'ring board',
        specifier: 'c6-neo',
        dir: pathlib.join(tempDir, 'node_modules/c6-neo/dist-fw'),
      },
      {
        name: '@fx/boards/b1',
        chip: 'esp32s3',
        description: undefined,
        specifier: '@fx/boards/b1',
        dir: pathlib.join(tempDir, 'node_modules/@fx/boards/dist-fw/b1'),
        buildDir: pathlib.join(tempDir, 'node_modules/@fx/boards/.mikro/build-fw-b1'),
      },
      {
        name: '@fx/boards/b2',
        chip: 'esp32',
        description: undefined,
        specifier: '@fx/boards/b2',
        dir: pathlib.join(tempDir, 'node_modules/@fx/boards/dist-fw/b2'),
      },
    ])
  })

  it('reads board packages from devDependencies', async () => {
    write(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', devDependencies: {'c6-neo': '*'}}),
    )
    installBoards(tempDir)
    expect((await discoverBoards(tempDir)).boards.map((b) => b.name)).toEqual(['c6-neo'])
  })

  it("skips an older @mikrojs/firmware's generic boards", async () => {
    write(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', dependencies: {'@mikrojs/firmware': '*'}}),
    )
    const firmware = pathlib.join(tempDir, 'node_modules/@mikrojs/firmware')
    write(
      pathlib.join(firmware, 'package.json'),
      JSON.stringify({
        name: '@mikrojs/firmware',
        exports: {'./esp32c6-generic': {firmware: './dist-fw/esp32c6-generic/firmware.json'}},
      }),
    )
    writeImage(pathlib.join(firmware, 'dist-fw/esp32c6-generic'), {
      name: 'esp32c6-generic',
      chip: 'esp32c6',
    })
    expect(await discoverBoards(tempDir)).toEqual({boards: [], problems: []})
  })

  it('ignores installed board packages the project does not depend on', async () => {
    write(pathlib.join(tempDir, 'package.json'), JSON.stringify({name: 'fixture'}))
    installBoards(tempDir)
    expect(await discoverBoards(tempDir)).toEqual({boards: [], problems: []})
  })

  it("leaves the generic images of the app's mikro to the bundled boards", async () => {
    write(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'app', dependencies: {mikro: '*'}}),
    )
    const generic = pathlib.join(tempDir, 'node_modules/mikro')
    write(
      pathlib.join(generic, 'package.json'),
      JSON.stringify({
        name: 'mikro',
        exports: {'./esp32c6-generic': {firmware: './dist-fw/esp32c6-generic/firmware.json'}},
      }),
    )
    writeImage(pathlib.join(generic, 'dist-fw/esp32c6-generic'), {
      name: 'esp32c6-generic',
      chip: 'esp32c6',
    })
    expect(await discoverBoards(tempDir)).toEqual({boards: [], problems: []})
  })
})

describe('bundledBoardsDir', () => {
  let app: string

  beforeEach(() => {
    app = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'bundled-')))
    write(pathlib.join(app, 'package.json'), JSON.stringify({name: 'app'}))
  })

  afterEach(() => {
    rmSync(app, {recursive: true, force: true})
  })

  const cli = pathlib.join(import.meta.dirname, '..', '..', '..', '..')

  it("takes the app's own mikro, when it has generic images", () => {
    // pnpm's layout: node_modules/mikro links into the store
    const store = pathlib.join(app, 'node_modules/.pnpm/mikro@1.0.0/node_modules/mikro')
    write(
      pathlib.join(store, 'package.json'),
      JSON.stringify({
        name: 'mikro',
        exports: {'./esp32c6-generic': {firmware: './dist-fw/esp32c6-generic/firmware.json'}},
      }),
    )
    symlinkSync(store, pathlib.join(app, 'node_modules/mikro'))

    expect(bundledBoardsDir(pathlib.join(app, 'src'))).toBe(pathlib.join(app, 'node_modules/mikro'))
  })

  it("falls back to this CLI's own without a mikro with images in the app", () => {
    expect(bundledBoardsDir(app)).toBe(cli)
    write(pathlib.join(app, 'node_modules/mikro/package.json'), '{"name": "mikro"}')
    expect(bundledBoardsDir(app)).toBe(cli)
  })
})

describe('staleImage', () => {
  it('reports an image older than its last build', () => {
    const pkg = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'stale-')))
    try {
      write(pathlib.join(pkg, 'package.json'), JSON.stringify({name: '@acme/devboard'}))
      writeImage(pathlib.join(pkg, 'dist-fw'), {name: '@acme/devboard', chip: 'esp32s3'})
      const buildDir = pathlib.join(pkg, '.mikro/build-fw')
      const board = {
        name: '@acme/devboard',
        chip: 'esp32s3',
        dir: pathlib.join(pkg, 'dist-fw'),
        buildDir,
      }
      expect(staleImage(board)).toBeUndefined()

      const built = pathlib.join(pkg, '.mikro/build-fw/mikrojs.bin')
      write(built, 'newer app')
      const later = new Date(Date.now() + 60_000)
      utimesSync(built, later, later)
      expect(staleImage(board)).toBe(
        `the image of @acme/devboard is older than its last build in ${buildDir}; run \`mikro fw prepack\` in its package`,
      )
    } finally {
      rmSync(pkg, {recursive: true, force: true})
    }
  })
})

/** The board a discovery found, and how. */
function found(discovery: BoardDiscovery) {
  expect(discovery.kind).toBe('board')
  return discovery.kind === 'board' ? {board: discovery.board, source: discovery.source} : undefined
}

describe('discoverBoard', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    // A project with no board dependencies, so only the bundled boards resolve.
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

  it('finds nothing when nothing selects a board', async () => {
    expect(await discoverBoard(undefined)).toEqual({kind: 'none', warnings: []})
  })

  it('resolves a generic board from the --board flag', async () => {
    const resolved = found(await discoverBoard('esp32c6-generic'))
    expect(resolved?.board.name).toBe('esp32c6-generic')
    expect(resolved?.board.chip).toBe('esp32c6')
    expect(resolved?.source).toBe('flag')
  })

  it('resolves a generic board from config.board when no flag is given', async () => {
    const resolved = found(await discoverBoard(undefined, 'esp32c6-generic'))
    expect(resolved?.board.name).toBe('esp32c6-generic')
    expect(resolved?.source).toBe('config')
  })

  describe('with one board dependency', () => {
    beforeEach(() => {
      write(
        pathlib.join(tempDir, 'package.json'),
        JSON.stringify({name: 'fixture', dependencies: {'c6-neo': '*'}}),
      )
      installBoards(tempDir)
    })

    it('picks the dependency when nothing names a board', async () => {
      const resolved = found(await discoverBoard(undefined))
      expect(resolved?.board.name).toBe('c6-neo')
      expect(resolved?.source).toBe('dependency')
    })

    it('lets config.board win over the dependency', async () => {
      const resolved = found(await discoverBoard(undefined, 'esp32c6-generic'))
      expect(resolved?.board.name).toBe('esp32c6-generic')
      expect(resolved?.source).toBe('config')
    })

    it("skips a board it can't use, with a warning", async () => {
      rmSync(pathlib.join(tempDir, 'node_modules/c6-neo/dist-fw'), {recursive: true})
      expect(await discoverBoard(undefined)).toEqual({
        kind: 'none',
        warnings: [expect.stringMatching(/^skipped c6-neo: not built: /)],
      })
    })
  })

  it('reports an unknown board with the known ones', async () => {
    expect(await discoverBoard('esp32c6-generc')).toEqual({
      kind: 'unknown',
      name: 'esp32c6-generc',
      source: 'flag',
      known: expect.arrayContaining(['esp32c6-generic']),
      warnings: [],
    })
  })

  describe('with board packages installed', () => {
    beforeEach(() => {
      write(
        pathlib.join(tempDir, 'package.json'),
        JSON.stringify({name: 'fixture', dependencies: {'c6-neo': '*', '@fx/boards': '*'}}),
      )
      installBoards(tempDir)
    })

    it('resolves a package board by the name its image reports', async () => {
      const resolved = found(await discoverBoard('@fx/boards/b1'))
      expect(resolved?.board.name).toBe('@fx/boards/b1')
      expect(resolved?.board.chip).toBe('esp32s3')
      expect(resolved?.source).toBe('flag')
    })

    it('finds a board by its own name, not the export that declares it', async () => {
      writeImage(pathlib.join(tempDir, 'node_modules/@fx/boards/dist-fw/b2'), {
        name: 'fx-b2',
        chip: 'esp32',
      })
      expect(found(await discoverBoard('fx-b2'))?.board.specifier).toBe('@fx/boards/b2')
      expect((await discoverBoard('@fx/boards/b2')).kind).toBe('unknown')
    })

    it('leaves several board dependencies to choose from', async () => {
      const discovery = await discoverBoard(undefined)
      expect(discovery.kind).toBe('choose')
      expect(discovery.kind === 'choose' && discovery.boards.map((b) => b.name)).toEqual([
        'c6-neo',
        '@fx/boards/b1',
        '@fx/boards/b2',
      ])
    })

    it('lets config.board choose among several board dependencies', async () => {
      const resolved = found(await discoverBoard(undefined, 'c6-neo'))
      expect(resolved?.board.name).toBe('c6-neo')
      expect(resolved?.source).toBe('config')
    })

    it('stops when two installed boards have the same name', async () => {
      writeImage(pathlib.join(tempDir, 'node_modules/@fx/boards/dist-fw/b2'), {
        name: 'c6-neo',
        chip: 'esp32',
      })
      await expect(discoverBoard('c6-neo')).rejects.toThrow(
        "Several installed boards are named 'c6-neo': c6-neo, @fx/boards/b2.",
      )
      await expect(discoverBoard(undefined)).rejects.toThrow(/Several installed boards/)
    })

    it('resolves a generic board whatever state the board packages are in', async () => {
      // A broken image must not block the flash that recovers a device.
      write(pathlib.join(tempDir, 'node_modules/c6-neo/dist-fw/firmware.json'), '{')
      const unknown = await discoverBoard('c6-neo')
      expect(unknown).toMatchObject({kind: 'unknown'})
      expect(unknown.warnings).toEqual([expect.stringMatching(/^skipped c6-neo: .*not valid JSON/)])
      const resolved = found(await discoverBoard('esp32c6-generic'))
      expect(resolved?.board.name).toBe('esp32c6-generic')
      expect(resolved?.source).toBe('flag')
    })
  })
})
