import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterAll, expect, test} from 'vitest'

import {
  archiveName,
  boardFileName,
  checkBoardPackage,
  firmwareExports,
  isArchiveForChip,
  loadBoards,
} from '../boards.ts'
import {chips} from '../index.ts'

const fixtureDir = mkdtempSync(join(tmpdir(), 'mik-fw-boards-'))

afterAll(() => {
  rmSync(fixtureDir, {recursive: true, force: true})
})

function write(file: string, content: string) {
  mkdirSync(dirname(file), {recursive: true})
  writeFileSync(file, content)
}

/** An image as `mikro fw prepack` leaves it: firmware.json, flasher_args.json
 *  and the files it lists. */
function writeImage(dir: string, firmware: Record<string, unknown>) {
  write(join(dir, 'firmware.json'), JSON.stringify(firmware))
  write(
    join(dir, 'flasher_args.json'),
    JSON.stringify({
      flash_files: {'0x0': 'bootloader/bootloader.bin', '0x10000': 'mikrojs.bin'},
      extra_esptool_args: {chip: firmware.chip},
    }),
  )
  write(join(dir, 'bootloader/bootloader.bin'), '')
  write(join(dir, 'mikrojs.bin'), '')
}

function boardPackage(name: string, pkg: Record<string, unknown>) {
  const dir = join(fixtureDir, name)
  write(join(dir, 'package.json'), JSON.stringify({name, ...pkg}))
  return dir
}

const t_display = {
  name: '@acme/boards/t-display',
  description: 'LILYGO T-Display',
  chip: 'esp32',
  version: '0.21.0',
}

test('each export with a firmware condition is a board, named by its firmware.json', () => {
  const dir = boardPackage('multi', {
    files: ['dist-fw/t-display', 'dist-fw/devkit-c6/'],
    exports: {
      './t-display': {
        firmware: './dist-fw/t-display/firmware.json',
        default: './dist/t-display.js',
      },
      './devkit-c6': {firmware: './dist-fw/devkit-c6/firmware.json'},
      './pins': './dist/pins.js',
    },
  })
  writeImage(join(dir, 'dist-fw/t-display'), t_display)
  writeImage(join(dir, 'dist-fw/devkit-c6'), {
    name: 'devkit-c6',
    chip: 'esp32c6',
    version: '0.21.0',
  })

  const {boards, problems} = loadBoards(dir)
  expect(problems).toEqual([])
  expect(boards).toEqual([
    {
      ...t_display,
      specifier: 'multi/t-display',
      key: './t-display',
      packageName: 'multi',
      packageDir: dir,
      dir: join(dir, 'dist-fw/t-display'),
    },
    {
      name: 'devkit-c6',
      description: undefined,
      chip: 'esp32c6',
      version: '0.21.0',
      specifier: 'multi/devkit-c6',
      key: './devkit-c6',
      packageName: 'multi',
      packageDir: dir,
      dir: join(dir, 'dist-fw/devkit-c6'),
    },
  ])
  // The name is the board's own; the specifier only locates it
  expect(checkBoardPackage(dir)).toEqual([])
})

test("the root export's board is the package's", () => {
  const dir = boardPackage('@acme/devboard', {
    exports: {'.': {firmware: './dist-fw/firmware.json', default: './dist/index.js'}},
  })
  expect(firmwareExports(dir).entries).toEqual([
    {
      key: '.',
      specifier: '@acme/devboard',
      target: './dist-fw/firmware.json',
      file: join(dir, 'dist-fw/firmware.json'),
    },
  ])
})

test('a firmware export that is not a board is a problem, not a board', () => {
  const dir = boardPackage('broken', {
    exports: {
      './unbuilt': {firmware: './dist-fw/unbuilt/firmware.json'},
      './not-json': {firmware: './not-json/firmware.json'},
      './other-tool': {firmware: './other-tool/firmware.json'},
      './bad-name': {firmware: './bad-name/firmware.json'},
      './pattern/*': {firmware: './pattern/*/firmware.json'},
      './not-a-path': {firmware: {default: './x.json'}},
    },
  })
  write(join(dir, 'not-json/firmware.json'), '{')
  // Another tool's `firmware` condition: no Mikro.js firmware.json
  write(join(dir, 'other-tool/firmware.json'), JSON.stringify({target: 'nrf52', version: 3}))
  write(
    join(dir, 'bad-name/firmware.json'),
    JSON.stringify({name: 'Acme Board', chip: 'esp32', version: '0.21.0'}),
  )

  const {boards, problems} = loadBoards(dir)
  expect(boards).toEqual([])
  const bySpecifier = Object.fromEntries(problems.map((p) => [p.specifier, p.message]))
  expect(bySpecifier['broken/unbuilt']).toMatch(/^not built: .*does not exist$/)
  expect(bySpecifier['broken/not-json']).toContain('is not valid JSON')
  expect(bySpecifier['broken/other-tool']).toMatch(/\(name\): missing required field$/)
  expect(bySpecifier['broken/bad-name']).toContain('"Acme Board" is not a board name')
  expect(bySpecifier['broken/pattern/*']).toContain("is under a pattern, which can't be listed")
  expect(bySpecifier['broken/not-a-path']).toContain('is not a path')
})

test('a chip the firmware does not support is rejected', () => {
  const dir = boardPackage('rp', {
    files: ['dist-fw'],
    exports: {'.': {firmware: './dist-fw/firmware.json'}},
  })
  writeImage(join(dir, 'dist-fw'), {name: 'rp', chip: 'rp2350', version: '0.21.0'})
  expect(loadBoards(dir).problems).toEqual([
    {specifier: 'rp', message: expect.stringContaining('(chip)')},
  ])
})

test('the check reports an image that would not publish or flash', () => {
  const dir = boardPackage('@acme/checked', {
    files: ['dist', 'dist-fw/a', 'dist-fw/b'],
    exports: {
      './a': {firmware: './dist-fw/a/firmware.json'},
      './b': {firmware: './dist-fw/b/firmware.json'},
      './c': {firmware: './dist-fw/c/firmware.json'},
      './outside': {firmware: '../elsewhere/dist-fw/firmware.json'},
    },
    publishConfig: {
      exports: {
        './a': {firmware: './dist-fw/a/firmware.json'},
        './b': {firmware: './b/build/firmware.json'},
        './c': {firmware: './dist-fw/c/firmware.json'},
        './outside': {firmware: '../elsewhere/dist-fw/firmware.json'},
      },
    },
  })
  writeImage(join(dir, 'dist-fw/a'), {name: 'twin', chip: 'esp32', version: '0.21.0'})
  writeImage(join(dir, 'dist-fw/b'), {name: 'twin', chip: 'esp32', version: '0.21.0'})
  rmSync(join(dir, 'dist-fw/b/mikrojs.bin'))
  writeImage(join(dir, 'dist-fw/c'), {name: 'c', chip: 'esp32', version: '0.21.0'})
  writeImage(join(fixtureDir, '@acme/elsewhere/dist-fw'), {name: 'x', chip: 'esp32', version: '1'})

  const messages = checkBoardPackage(dir).map((p) => `${p.specifier}: ${p.message}`)
  expect(messages).toEqual(
    expect.arrayContaining([
      '@acme/checked/c: the image folder dist-fw/c is not in "files", so it isn\'t published',
      '@acme/checked/outside: ../elsewhere/dist-fw/firmware.json is outside the package',
      `@acme/checked/b: ${join(dir, 'dist-fw/b/mikrojs.bin')} does not exist`,
      '@acme/checked/b: @acme/checked/a and @acme/checked/b are both named "twin"',
      '@acme/checked/b: the "firmware" condition of "./b" differs between "exports" and "publishConfig.exports"',
    ]),
  )
  expect(messages).toHaveLength(5)
})

test('a package without "files" does not publish its gitignored image', () => {
  const dir = boardPackage('no-files', {exports: {'.': {firmware: './dist-fw/firmware.json'}}})
  writeImage(join(dir, 'dist-fw'), {name: 'no-files', chip: 'esp32c6', version: '0.21.0'})
  expect(checkBoardPackage(dir)).toEqual([
    {
      specifier: 'no-files',
      message: 'the image folder dist-fw is not in "files", so it isn\'t published',
    },
  ])
})

test('@mikrojs/firmware declares a generic image for every chip, the same when published', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
  ) as {exports: Record<string, unknown>; publishConfig: {exports: Record<string, unknown>}}
  for (const chip of chips) {
    const entry = {firmware: `./dist-fw/${chip}-generic/firmware.json`}
    expect(pkg.exports[`./${chip}-generic`]).toEqual(entry)
    expect(pkg.publishConfig.exports[`./${chip}-generic`]).toEqual(entry)
  }
})

test('file names drop the scope marker and turn slashes into dashes', () => {
  expect(boardFileName('@acme/boards/t-display')).toBe('acme-boards-t-display')
  expect(boardFileName('esp32c6-generic')).toBe('esp32c6-generic')
})

test('an exports object of conditions is the root export', () => {
  const dir = boardPackage('conditions', {
    files: ['dist-fw'],
    exports: {firmware: './dist-fw/firmware.json', default: './dist/index.js'},
  })
  writeImage(join(dir, 'dist-fw'), {name: 'conditions', chip: 'esp32c6', version: '0.21.0'})
  expect(loadBoards(dir).boards.map((b) => b.specifier)).toEqual(['conditions'])
  expect(checkBoardPackage(dir)).toEqual([])
})

test('unreadable JSON is a problem, not a crash', () => {
  const broken = join(fixtureDir, 'broken-package')
  write(join(broken, 'package.json'), '{"name": ')
  expect(loadBoards(broken)).toEqual({
    boards: [],
    problems: [{specifier: broken, message: expect.stringContaining('cannot read')}],
  })
  expect(checkBoardPackage(broken)).toEqual([
    {specifier: broken, message: expect.stringContaining('cannot read')},
  ])

  const dir = boardPackage('bad-flasher-args', {
    files: ['dist-fw'],
    exports: {'.': {firmware: './dist-fw/firmware.json'}},
  })
  writeImage(join(dir, 'dist-fw'), {name: 'bad-flasher-args', chip: 'esp32c6', version: '0.21.0'})
  write(join(dir, 'dist-fw/flasher_args.json'), '{')
  expect(checkBoardPackage(dir)).toEqual([
    {specifier: 'bad-flasher-args', message: expect.stringContaining('is not valid JSON')},
  ])
})

test('archives are named after the firmware and the chip, the chip last', () => {
  expect(archiveName('@acme/boards/t-display', 'esp32')).toBe(
    'mikro-fw-acme-boards-t-display-esp32',
  )
  expect(archiveName('my-firmware', 'esp32c6')).toBe('mikro-fw-my-firmware-esp32c6')
  expect(archiveName('esp32c6-generic', 'esp32c6')).toBe('mikro-fw-esp32c6-generic')
  expect(archiveName('seeed-xiao-esp32c6', 'esp32c6')).toBe('mikro-fw-seeed-xiao-esp32c6')
  // A chip elsewhere in the name is not the chip
  expect(archiveName('esp32-devkit', 'esp32c6')).toBe('mikro-fw-esp32-devkit-esp32c6')
  expect(archiveName('esp32-devkit', 'esp32')).toBe('mikro-fw-esp32-devkit-esp32')
  expect(archiveName(undefined, 'esp32s3')).toBe('mikro-fw-esp32s3')
})

test('an archive is for the chip in the place archiveName puts it', () => {
  expect(isArchiveForChip('mikro-fw-esp32-devkit-esp32c6', 'esp32c6')).toBe(true)
  expect(isArchiveForChip('mikro-fw-esp32-devkit-esp32c6', 'esp32')).toBe(false)
  expect(isArchiveForChip('mikro-fw-acme-esp32-board-esp32s3', 'esp32')).toBe(false)
  expect(isArchiveForChip('mikro-fw-esp32c6-generic', 'esp32c6')).toBe(true)
  expect(isArchiveForChip('mikro-fw-esp32', 'esp32')).toBe(true)
  expect(isArchiveForChip('mikrojs-firmware-esp32', 'esp32')).toBe(false)
})
