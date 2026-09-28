import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {afterAll, expect, test} from 'vitest'

import {
  archiveName,
  boardFileName,
  checkBoardPackage,
  checkBoardsConfig,
  firmwareExports,
  imageName,
  loadBoards,
  sortImageName,
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

/** An image as `mikro fw build` leaves it: firmware.json, flasher_args.json
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

function configured(name: string, pkg: Record<string, unknown>, config: unknown) {
  const dir = boardPackage(name, pkg)
  return {dir, ...checkBoardsConfig(dir, config)}
}

test('a boards.config.ts board takes its defaults from the package and its export', () => {
  const {dir, boards, problems} = configured(
    '@acme/boards',
    {
      description: 'ACME boards',
      exports: {
        './t-display': {firmware: './dist-fw/t-display/full/firmware.json', default: './dist/t.js'},
        './devkit': {firmware: './dist-fw/devkit/full/firmware.json'},
      },
    },
    {
      boards: {
        './t-display': {chip: 'esp32', name: 't-display', description: 'T-Display'},
        './devkit': {chip: 'esp32c6', nativeModules: ['@acme/drivers/a']},
      },
    },
  )
  expect(problems).toEqual([])
  expect(boards).toEqual([
    {
      key: './t-display',
      specifier: '@acme/boards/t-display',
      name: 't-display',
      description: 'T-Display',
      chip: 'esp32',
      sdkconfig: [],
      partitions: undefined,
      nativeModules: [],
      project: undefined,
      target: './dist-fw/t-display/full/firmware.json',
      boardDir: join(dir, 'dist-fw/t-display'),
      images: [],
    },
    {
      key: './devkit',
      specifier: '@acme/boards/devkit',
      name: '@acme/boards/devkit',
      description: 'ACME boards',
      chip: 'esp32c6',
      sdkconfig: [],
      partitions: undefined,
      nativeModules: ['@acme/drivers/a'],
      project: undefined,
      target: './dist-fw/devkit/full/firmware.json',
      boardDir: join(dir, 'dist-fw/devkit'),
      images: [],
    },
  ])
})

test('a board at "." puts its images in the dist folder itself, and resolves its files', () => {
  const {dir, boards, problems} = configured(
    'devboard',
    {exports: {'.': {firmware: './out/full/firmware.json'}}},
    {dist: 'out', boards: {'.': {chip: 'esp32s3', sdkconfig: 'a.defaults', partitions: 'p.csv'}}},
  )
  expect(problems).toEqual([
    {specifier: 'devboard', message: 'boards.config.ts, board ".": a.defaults does not exist'},
    {specifier: 'devboard', message: 'boards.config.ts, board ".": p.csv does not exist'},
  ])
  expect(boards[0]).toMatchObject({
    target: './out/full/firmware.json',
    boardDir: join(dir, 'out'),
    sdkconfig: [join(dir, 'a.defaults')],
    partitions: join(dir, 'p.csv'),
  })
})

test('boards.config.ts problems name the board and the field', () => {
  const exports = {
    '.': {firmware: './dist-fw/full/firmware.json'},
  }
  const mixed = configured(
    'mixed',
    {exports},
    {boards: {'.': {chip: 'esp32'}, './b': {chip: 'esp32'}}},
  )
  expect(mixed.problems.map((p) => p.message)).toEqual([
    'boards.config.ts: a package has one board at "." or boards at "./<board>", not both',
  ])

  const bad = configured(
    'bad',
    {
      exports: {
        './a': {firmware: './dist-fw/a/full/firmware.json'},
        './z': {firmware: './dist-fw/z/full/firmware.json'},
      },
    },
    {
      extra: 1,
      boards: {
        './a': {chip: 'esp99', typo: true},
        './B': {chip: 'esp32'},
        './c': {chip: 'esp32', project: 'fw', sdkconfig: 'x.defaults'},
      },
    },
  )
  expect(bad.problems.map((p) => `${p.specifier}: ${p.message}`)).toEqual([
    'bad: boards.config.ts: unknown field "extra"',
    'bad/a: boards.config.ts, board "./a": unknown field "typo"',
    `bad/a: boards.config.ts, board "./a": "chip" must be one of ${chips.join(', ')}`,
    'bad/B: boards.config.ts, board "./B": a board is "." or "./<board>", lowercase letters, digits, "." and "-"',
    'bad/c: boards.config.ts, board "./c": a board with "project" takes its settings, partition table and native modules from that project; leave out "sdkconfig", "partitions" and "nativeModules"',
    'bad/c: boards.config.ts, board "./c": x.defaults does not exist',
    'bad/c: boards.config.ts, board "./c": fw/CMakeLists.txt does not exist',
    'bad/c: "exports" has no "firmware" condition for "./c"',
    'bad/z: "./z" has a "firmware" condition in "exports", but boards.config.ts has no board "./z"',
    'bad: add these to "exports" in package.json (next to any other conditions of the same export):\n  "./c": {"firmware": "./dist-fw/c/full/firmware.json"}',
  ])
})

test('boards.config.ts refuses names a device cannot take, and names used twice', () => {
  const long = `@acme/${'x'.repeat(60)}`
  const {problems} = configured(
    long,
    {
      exports: {
        './a': {firmware: './dist-fw/a/full/firmware.json'},
        './b': {firmware: './dist-fw/b/full/firmware.json'},
      },
    },
    {boards: {'./a': {chip: 'esp32'}, './b': {chip: 'esp32', name: 'twin'}}},
  )
  expect(problems.map((p) => p.message)).toEqual([
    `boards.config.ts, board "./a": "${long}/a" is not a board name (at most 63 characters, the form of a package name with an optional /<board>); set "name"`,
  ])
  const twins = configured(
    'twins',
    {
      exports: {
        './a': {firmware: './dist-fw/a/full/firmware.json'},
        './b': {firmware: './dist-fw/b/full/firmware.json'},
      },
    },
    {boards: {'./a': {chip: 'esp32', name: 'twin'}, './b': {chip: 'esp32', name: 'twin'}}},
  )
  expect(twins.problems.map((p) => p.message)).toEqual([
    'boards.config.ts: boards "./a" and "./b" are both named "twin"',
  ])
})

test('an image is named by what it leaves out or adds, sorted', () => {
  expect(imageName({ble: false})).toBe('no-ble')
  expect(imageName({wifi: false, ble: false})).toBe('no-ble+no-wifi')
  expect(imageName({wifi: true})).toBe('wifi')
})

test('an image name in any order sorts to the name imageName gives', () => {
  expect(sortImageName('no-wifi+no-ble')).toBe('no-ble+no-wifi')
  expect(sortImageName('wifi+no-ble')).toBe('no-ble+wifi')
  expect(sortImageName('no-ble')).toBe('no-ble')
  expect(sortImageName('full')).toBe('full')
})

test('images in boards.config.ts switch features off and on, beside the full image', () => {
  const {dir, boards, problems} = configured(
    'lean',
    {exports: {'.': {firmware: './dist-fw/full/firmware.json'}}},
    {boards: {'.': {chip: 'esp32c6', images: [{ble: false}, {wifi: false, ble: false}]}}},
  )
  expect(problems).toEqual([])
  expect(boards[0]!.images).toEqual([
    {
      name: 'no-ble',
      features: {ble: false},
      settings: ['CONFIG_BT_ENABLED=n'],
      dir: join(dir, 'dist-fw/no-ble'),
    },
    {
      name: 'no-ble+no-wifi',
      features: {wifi: false, ble: false},
      settings: ['CONFIG_MIKROJS_WIFI=n', 'CONFIG_BT_ENABLED=n'],
      dir: join(dir, 'dist-fw/no-ble+no-wifi'),
    },
  ])
})

test('boards.config.ts refuses images it cannot build', () => {
  const exports = {'.': {firmware: './dist-fw/full/firmware.json'}}
  const messages = (images: unknown, extra: Record<string, unknown> = {}) =>
    configured(
      'lean-bad',
      {exports},
      {boards: {'.': {chip: 'esp32', images, ...extra}}},
    ).problems.map((p) => p.message.replace('boards.config.ts, board ".": ', ''))
  const features =
    'each image switches features off or on, like {ble: false}; the features are ble, wifi'
  expect(messages([{}])).toEqual([features])
  expect(messages([{ble: 'no'}])).toEqual([features])
  expect(messages([{thread: false}])).toEqual([features])
  expect(messages([{ble: false}, {ble: false}])).toEqual(['two images are no-ble'])
  expect(messages({ble: false})).toEqual(['"images" must be a list, like [{ble: false}]'])
})

test("a board's other images are the folders beside full/ with an image of it", () => {
  const dir = boardPackage('with-images', {
    files: ['dist-fw'],
    exports: {'.': {firmware: './dist-fw/full/firmware.json'}},
  })
  const board = {name: 'with-images', chip: 'esp32c6', version: '0.21.0'}
  writeImage(join(dir, 'dist-fw/full'), {...board, features: ['wifi', 'ble', 'i2s']})
  writeImage(join(dir, 'dist-fw/no-wifi'), {...board, features: ['ble', 'i2s']})
  writeImage(join(dir, 'dist-fw/no-ble'), {...board, features: ['wifi', 'i2s']})
  // Not images of this board: another board's, another chip's, not an image name
  writeImage(join(dir, 'dist-fw/no-ble+no-wifi'), {...board, name: 'other'})
  writeImage(join(dir, 'dist-fw/no-i2s'), {...board, chip: 'esp32s3'})
  writeImage(join(dir, 'dist-fw/Backup'), board)
  expect(loadBoards(dir).boards[0]).toMatchObject({
    features: ['wifi', 'ble', 'i2s'],
    images: [
      {name: 'no-ble', features: ['wifi', 'i2s'], dir: join(dir, 'dist-fw/no-ble')},
      {name: 'no-wifi', features: ['ble', 'i2s'], dir: join(dir, 'dist-fw/no-wifi')},
    ],
  })
  // Each one is checked like the full image
  rmSync(join(dir, 'dist-fw/no-ble/mikrojs.bin'))
  expect(checkBoardPackage(dir).map((p) => p.message)).toEqual([
    `${join(dir, 'dist-fw/no-ble/mikrojs.bin')} does not exist`,
  ])
})

test('an image outside full/ has no other images', () => {
  const dir = boardPackage('flat', {
    files: ['dist-fw'],
    exports: {'./a': {firmware: './dist-fw/a/firmware.json'}},
  })
  writeImage(join(dir, 'dist-fw/a'), {name: 'flat', chip: 'esp32c6', version: '0.21.0'})
  writeImage(join(dir, 'dist-fw/no-ble'), {name: 'flat', chip: 'esp32c6', version: '0.21.0'})
  expect(loadBoards(dir).boards[0]!.images).toBeUndefined()
})

test('boards.config.ts must export a config with boards', () => {
  const dir = boardPackage('empty', {})
  for (const config of [undefined, {}, {boards: {}}]) {
    expect(checkBoardsConfig(dir, config).problems).toHaveLength(1)
  }
  expect(checkBoardsConfig(dir, {dist: '../out', boards: {'.': {chip: 'esp32'}}}).problems).toEqual(
    [{specifier: 'empty', message: 'boards.config.ts: "dist" must be a folder in the package'}],
  )
  // The problems found before one that stops the check are kept
  expect(checkBoardsConfig(dir, {typo: 1, dist: '../out', boards: {}}).problems).toEqual([
    {specifier: 'empty', message: 'boards.config.ts: unknown field "typo"'},
    {specifier: 'empty', message: 'boards.config.ts: "dist" must be a folder in the package'},
  ])
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
