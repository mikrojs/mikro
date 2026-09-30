import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {getWriteFlashMultiArgs} from '../esptool.js'
import {
  chooseImage,
  flashFirmware,
  type FlashPlan,
  parseFeatures,
  resolveFlashPlan,
} from '../flashFirmware.js'
import {appImage} from './appImage.js'

// No real esptool: chip detection fails, which the plan treats as "unknown"
// and falls back to the board's chip or the one --chip names.
const esptool = vi.hoisted(() => ({path: '/nonexistent/esptool'}))
vi.mock('@mikrojs/esptool', () => ({getEsptoolPath: async () => esptool.path}))

// `--from` without the network: the download is the image in `downloaded.dir`.
const downloaded = vi.hoisted(() => ({dir: '', calls: [] as unknown[]}))
vi.mock('../firmware.js', () => ({
  resolveFrom: async (url: unknown) => {
    downloaded.calls.push(url)
    return downloaded.dir
  },
}))

// The copies of generic images with a board's name written in, out of the
// user's cache.
const cache = vi.hoisted(() => ({dir: ''}))
vi.mock('../envPaths.js', () => ({
  paths: {
    get cache() {
      return cache.dir
    },
  },
}))

// The bundled esp32c6 image, whether or not the workspace has built one.
const bundled = vi.hoisted(() => ({dir: ''}))
vi.mock('../bundledImages.js', () => ({
  bundledBoardsDir: () => bundled.dir,
  bundledImages: () => ({
    boards: [
      {
        name: 'esp32c6-generic',
        chip: 'esp32c6',
        version: '0.21.0',
        specifier: 'mikro/esp32c6-generic',
        key: './esp32c6-generic',
        packageName: 'mikro',
        packageDir: bundled.dir,
        dir: bundled.dir,
      },
    ],
    problems: [],
  }),
}))

// The app binary is named after the firmware project's project(), not mikrojs.bin
const FLASHER_ARGS = JSON.stringify({
  flash_files: {'0x0': 'bootloader.bin', '0x10000': 'app.bin'},
  app: {offset: '0x10000', file: 'app.bin'},
  extra_esptool_args: {chip: 'esp32c6', before: 'default_reset', after: 'hard_reset'},
  flash_settings: {flash_mode: 'dio', flash_size: '4MB', flash_freq: '80m'},
})

function write(file: string, content: string) {
  mkdirSync(pathlib.dirname(file), {recursive: true})
  writeFileSync(file, content)
}

function writeImage(dir: string, name: string, chip = 'esp32c6') {
  write(pathlib.join(dir, 'firmware.json'), JSON.stringify({name, chip, version: '0.21.0'}))
  write(pathlib.join(dir, 'flasher_args.json'), FLASHER_ARGS)
  write(pathlib.join(dir, 'bootloader.bin'), '')
  write(pathlib.join(dir, 'app.bin'), '')
}

/** Two esp32c6 board packages. */
function installBoards(dir: string) {
  write(
    pathlib.join(dir, 'package.json'),
    JSON.stringify({name: 'fixture', dependencies: {plain: '*', ring: '*'}}),
  )
  for (const name of ['plain', 'ring']) {
    const pkg = pathlib.join(dir, 'node_modules', name)
    write(
      pathlib.join(pkg, 'package.json'),
      JSON.stringify({name, exports: {'.': {firmware: './dist-fw/full/firmware.json'}}}),
    )
    writeImage(pathlib.join(pkg, 'dist-fw', 'full'), name)
  }
  return pathlib.join(dir, 'node_modules/ring')
}

/** The plan, when it is one rather than a choice of boards. */
function plan_(result: FlashPlan | {choose: unknown}): FlashPlan {
  if ('choose' in result) throw new Error('expected a plan, got a choice of boards')
  return result
}

/** The files esptool compares the plan's files with, in order (`--diff-with`). */
function diffs(plan: FlashPlan): string[] {
  const args = getWriteFlashMultiArgs({
    port: '/dev/null',
    baudRate: 460800,
    files: plan.flasherArgs.files,
  })
  return args.slice(args.indexOf('--diff-with') + 1, args.indexOf('--'))
}

/** The board name in an app binary's slot. */
function nameIn(file: string): string {
  return readFileSync(file)
    .subarray(0x124, 0x124 + 64)
    .toString()
    .replace(/\0+$/, '')
}

describe('getWriteFlashMultiArgs', () => {
  const files = [
    {address: 0x0, filename: 'bootloader.bin'},
    {address: 0x10000, filename: 'app.bin'},
  ]
  const options = {port: '/dev/null', baudRate: 460800}

  it('pairs the files with the ones to diff with, and ends the list before them', () => {
    const args = getWriteFlashMultiArgs({
      ...options,
      files: [{...files[0]!, diffWith: 'bootloader.bin'}, files[1]!],
    })
    expect(args.slice(args.indexOf('--diff-with'))).toEqual([
      '--diff-with',
      'bootloader.bin',
      'skip',
      '--',
      '0',
      'bootloader.bin',
      '65536',
      'app.bin',
    ])
  })

  it('leaves the list out when no file has one', () => {
    const args = getWriteFlashMultiArgs({...options, files})
    expect(args).not.toContain('--diff-with')
    expect(args).not.toContain('--')
  })
})

describe('chooseImage', () => {
  const board = {
    name: 'ring',
    chip: 'esp32c6',
    dir: '/ring',
    features: ['wifi', 'ble'],
    images: [{name: 'no-ble', features: ['wifi'], dir: '/ring/no-ble'}],
  }

  it('takes full by name, and without images or a match, the full image', () => {
    expect(chooseImage(board, ['full'], ['wifi'])).toEqual({
      dir: '/ring',
      chosenImage: {name: 'full', source: 'features'},
    })
    expect(chooseImage(board, undefined, undefined)).toEqual({dir: '/ring'})
    expect(chooseImage(board, undefined, ['ble'])).toEqual({dir: '/ring'})
    expect(chooseImage({...board, images: undefined}, undefined, ['wifi'])).toEqual({
      dir: '/ring',
    })
  })

  it("keeps the device's image when this version's images have more features", () => {
    const next = {
      ...board,
      features: ['wifi', 'ble', 'thread'],
      images: [{name: 'no-ble', features: ['wifi', 'thread'], dir: '/ring/no-ble'}],
    }
    expect(chooseImage(next, undefined, ['wifi'])).toEqual({
      dir: '/ring/no-ble',
      chosenImage: {name: 'no-ble', source: 'device'},
    })
    // A feature no image has any more: the full image
    expect(chooseImage(next, undefined, ['wifi', 'zigbee'])).toEqual({dir: '/ring'})
  })

  it('reads --features as a list, min as the leanest image', () => {
    expect(parseFeatures('wifi, ble')).toEqual(['wifi', 'ble'])
    expect(parseFeatures('no-ble+no-wifi')).toEqual(['no-ble', 'no-wifi'])
    expect(parseFeatures('min')).toEqual([])
    expect(parseFeatures('')).toEqual([])
    const lean = {
      ...board,
      images: [...board.images, {name: 'no-ble+no-wifi', features: [], dir: '/ring/none'}],
    }
    expect(chooseImage(lean, parseFeatures('min'), undefined).chosenImage).toEqual({
      name: 'no-ble+no-wifi',
      source: 'features',
    })
  })

  it('takes the leanest image with the features asked for', () => {
    const lean = {
      ...board,
      features: ['wifi', 'ble', 'i2s'],
      images: [
        {name: 'no-ble', features: ['wifi', 'i2s'], dir: '/ring/no-ble'},
        {name: 'no-wifi', features: ['ble', 'i2s'], dir: '/ring/no-wifi'},
        {name: 'no-ble+no-wifi', features: ['i2s'], dir: '/ring/none'},
      ],
    }
    const pick = (features: string[]) => chooseImage(lean, features, undefined).chosenImage
    expect(pick(['wifi'])).toEqual({name: 'no-ble', source: 'features'})
    expect(pick(['ble'])).toEqual({name: 'no-wifi', source: 'features'})
    expect(pick(['wifi', 'ble'])).toEqual({name: 'full', source: 'features'})
    expect(pick(['i2s'])).toEqual({name: 'no-ble+no-wifi', source: 'features'})
    // None fits only when the firmware lacks the feature altogether
    const images =
      'Its images: full (wifi, ble, i2s), no-ble (wifi, i2s), no-wifi (ble, i2s), ' +
      'no-ble+no-wifi (i2s)'
    expect(() => pick(['wifi', 'thread'])).toThrow(`ring's firmware has no thread.\n${images}`)
    expect(() => pick(['wify'])).toThrow(`ring's firmware has no wify. Did you mean wifi?`)
    // A full image that lists no features has them all
    expect(chooseImage({...lean, features: undefined}, ['ble', 'wifi'], undefined)).toMatchObject({
      chosenImage: {name: 'full'},
    })
  })

  it('takes the full image without the feature no-<feature> names', () => {
    const lean = {
      ...board,
      features: ['wifi', 'ble', 'i2s'],
      images: [
        {name: 'no-ble', features: ['wifi', 'i2s'], dir: '/ring/no-ble'},
        {name: 'no-ble+no-wifi', features: ['i2s'], dir: '/ring/none'},
      ],
    }
    const pick = (features: string) =>
      chooseImage(lean, parseFeatures(features), undefined).chosenImage
    // Not the leanest image without BLE, which leaves out WiFi too
    expect(pick('no-ble')).toEqual({name: 'no-ble', source: 'features'})
    expect(pick('wifi,no-ble')).toEqual({name: 'no-ble', source: 'features'})
    expect(pick('no-ble,no-wifi')).toEqual({name: 'no-ble+no-wifi', source: 'features'})
    expect(pick('no-ble+no-wifi')).toEqual({name: 'no-ble+no-wifi', source: 'features'})
    // The image without WiFi also leaves out BLE
    const images = 'Its images: full (wifi, ble, i2s), no-ble (wifi, i2s), no-ble+no-wifi (i2s)'
    expect(() => pick('no-wifi')).toThrow(
      `ring has no image with ble, i2s and without wifi.\n${images}`,
    )
    expect(() => pick('ble,no-ble')).toThrow(
      'ring has no image with wifi, i2s, ble and without ble.',
    )
    expect(() => pick('no-bel')).toThrow(`ring's firmware has no bel. Did you mean ble?`)
    // An image can add a feature: without it, that is the full image
    const adds = {
      ...board,
      features: ['wifi'],
      images: [{name: 'ble', features: ['wifi', 'ble'], dir: '/ring/ble'}],
    }
    expect(chooseImage(adds, parseFeatures('no-ble'), undefined).chosenImage).toEqual({
      name: 'full',
      source: 'features',
    })
  })
})

describe('resolveFlashPlan', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'flash-plan-')))
    process.chdir(tempDir)
    bundled.dir = pathlib.join(tempDir, 'bundled')
    cache.dir = pathlib.join(tempDir, 'cache')
    writeImage(bundled.dir, 'esp32c6-generic')
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tempDir, {recursive: true, force: true})
    esptool.path = '/nonexistent/esptool'
  })

  it("says why the chip wasn't detected, in esptool's words", async () => {
    // What esptool prints when another program holds the port
    const busy =
      "A fatal error occurred: Could not open /dev/null, the port is busy or doesn't exist.\n" +
      '([Errno 35] Could not exclusively lock port /dev/null: [Errno 35] Resource temporarily unavailable)'
    esptool.path = pathlib.join(tempDir, 'esptool')
    write(esptool.path, `#!/bin/sh\ncat >&2 <<'EOF'\n\n${busy}\n\nEOF\nexit 2\n`)
    chmodSync(esptool.path, 0o755)

    const error = await resolveFlashPlan({port: '/dev/null'}).catch((e: unknown) => e)
    expect(error).toMatchObject({
      message: 'Could not detect chip type',
      cause: expect.objectContaining({message: busy}),
    })
  })

  it('flashes the image a board package ships', async () => {
    const ring = installBoards(tempDir)
    const plan = plan_(await resolveFlashPlan({port: '/dev/null', board: 'ring'}))
    expect(plan.image).toBe('board')
    expect(plan.board).toEqual({name: 'ring', source: 'flag'})
    expect(plan.flasherArgs.files.map((f) => f.filename)).toEqual([
      pathlib.join(ring, 'dist-fw/full/bootloader.bin'),
      pathlib.join(ring, 'dist-fw/full/app.bin'),
    ])
  })

  it('flashes the generic image for a board that runs one, with its name written in', async () => {
    writeFileSync(pathlib.join(bundled.dir, 'app.bin'), appImage())
    write(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', dependencies: {boards: '*'}}),
    )
    const boards = pathlib.join(tempDir, 'node_modules/boards')
    write(
      pathlib.join(boards, 'package.json'),
      JSON.stringify({
        name: 'boards',
        exports: {'./t-display': {firmware: './dist-fw/t-display/full/firmware.json'}},
      }),
    )
    write(
      pathlib.join(boards, 'dist-fw/t-display/full/firmware.json'),
      JSON.stringify({name: 'boards/t-display', firmware: 'esp32c6-generic'}),
    )

    // The only board dependency, picked without naming it
    const plan = plan_(await resolveFlashPlan({port: '/dev/null'}))
    expect(plan.image).toBe('board')
    expect(plan.board).toEqual({
      name: 'boards/t-display',
      source: 'dependency',
      firmware: 'esp32c6-generic',
    })
    const [bootloader, app] = plan.flasherArgs.files
    expect(bootloader!.filename).toBe(pathlib.join(bundled.dir, 'bootloader.bin'))
    expect(app!.filename).toBe(
      pathlib.join(cache.dir, 'app-images', 'boards-t-display+bundled.bin'),
    )
    const name = readFileSync(app!.filename).subarray(0x124, 0x124 + 16)
    expect(name.toString()).toBe('boards/t-display')

    write(
      pathlib.join(boards, 'dist-fw/t-display/full/firmware.json'),
      JSON.stringify({name: 'boards/t-display', firmware: 'esp32c9-generic'}),
    )
    await expect(resolveFlashPlan({port: '/dev/null', board: 'boards/t-display'})).rejects.toThrow(
      'skipped boards/t-display: it runs esp32c9-generic, which is not a generic board this CLI has',
    )
  })

  it('keeps the board a device on the generic firmware was flashed as, when nothing else names one', async () => {
    writeFileSync(pathlib.join(bundled.dir, 'app.bin'), appImage())
    write(pathlib.join(tempDir, 'package.json'), JSON.stringify({name: 'fixture'}))
    const deviceBoard = {name: 'acme/t-display', firmware: 'esp32c6-generic'}

    const kept = plan_(await resolveFlashPlan({port: '/dev/null', deviceBoard}))
    expect(kept.board).toEqual({
      name: 'acme/t-display',
      source: 'device',
      firmware: 'esp32c6-generic',
    })
    const app = kept.flasherArgs.files.find((f) => f.address === 0x10000)!
    expect(
      readFileSync(app.filename)
        .subarray(0x124, 0x124 + 14)
        .toString(),
    ).toBe('acme/t-display')

    // --board and mikro.config.ts still choose
    const named = plan_(
      await resolveFlashPlan({port: '/dev/null', deviceBoard, configBoard: 'esp32c6-generic'}),
    )
    expect(named.board).toEqual({name: 'esp32c6-generic', source: 'config'})

    // A board dependency comes first, as over a board's own image, except on
    // an automatic reflash
    write(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', dependencies: {ring: '*'}}),
    )
    const ring = pathlib.join(tempDir, 'node_modules', 'ring')
    write(
      pathlib.join(ring, 'package.json'),
      JSON.stringify({name: 'ring', exports: {'.': {firmware: './dist-fw/full/firmware.json'}}}),
    )
    writeImage(pathlib.join(ring, 'dist-fw', 'full'), 'ring')
    const dependency = plan_(await resolveFlashPlan({port: '/dev/null', deviceBoard}))
    expect(dependency.board).toEqual({name: 'ring', source: 'dependency'})
    const reflash = plan_(await resolveFlashPlan({port: '/dev/null', deviceBoard, reflash: true}))
    expect(reflash.board).toEqual({
      name: 'acme/t-display',
      source: 'device',
      firmware: 'esp32c6-generic',
    })
  })

  // What the diff tests share: the generic image's app, and a device on it
  const deviceFirmware = {name: 'esp32c6-generic', version: '0.21.0'}
  const onGeneric = (name: string) => ({name, firmware: 'esp32c6-generic'})
  const copy = (name: string) => pathlib.join(cache.dir, 'app-images', `${name}+bundled.bin`)

  /** A board package with `boards/t-display` on the generic image, the
   *  project's only board dependency. */
  function installGenericBoard() {
    write(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', dependencies: {boards: '*'}}),
    )
    const boards = pathlib.join(tempDir, 'node_modules/boards')
    write(
      pathlib.join(boards, 'package.json'),
      JSON.stringify({
        name: 'boards',
        exports: {'./t-display': {firmware: './dist-fw/t-display/full/firmware.json'}},
      }),
    )
    write(
      pathlib.join(boards, 'dist-fw/t-display/full/firmware.json'),
      JSON.stringify({name: 'boards/t-display', firmware: 'esp32c6-generic'}),
    )
  }

  it('diffs the generic image with what a device on it holds', async () => {
    const app = pathlib.join(bundled.dir, 'app.bin')
    const bootloader = pathlib.join(bundled.dir, 'bootloader.bin')
    writeFileSync(app, appImage())
    const generic = {port: '/dev/null', configBoard: 'esp32c6-generic', deviceFirmware}

    // The same image: esptool skips each file the flash holds
    expect(diffs(plan_(await resolveFlashPlan(generic)))).toEqual([bootloader, app])
    // The device runs it as a board: the copy with that name, for two sectors
    const named = plan_(await resolveFlashPlan({...generic, deviceBoard: onGeneric('acme/old')}))
    expect(named.flasherArgs.files[1]!.filename).toBe(app)
    expect(diffs(named)).toEqual([bootloader, copy('acme-old')])
    expect(nameIn(copy('acme-old'))).toBe('acme/old')
  })

  it("diffs a board's copy of the generic image with the plain image or another board's copy", async () => {
    const app = pathlib.join(bundled.dir, 'app.bin')
    const bootloader = pathlib.join(bundled.dir, 'bootloader.bin')
    writeFileSync(app, appImage())
    installGenericBoard()
    const board = {port: '/dev/null', deviceFirmware}

    const plain = plan_(await resolveFlashPlan(board))
    expect(plain.flasherArgs.files[1]!.filename).toBe(copy('boards-t-display'))
    expect(nameIn(copy('boards-t-display'))).toBe('boards/t-display')
    expect(diffs(plain)).toEqual([bootloader, app])
    const renamed = plan_(await resolveFlashPlan({...board, deviceBoard: onGeneric('acme/old')}))
    expect(diffs(renamed)).toEqual([bootloader, copy('acme-old')])
    const same = plan_(
      await resolveFlashPlan({...board, deviceBoard: onGeneric('boards/t-display')}),
    )
    expect(diffs(same)).toEqual([bootloader, copy('boards-t-display')])
  })

  it('makes no guess for a board name with the same file name as the one flashed', async () => {
    writeFileSync(pathlib.join(bundled.dir, 'app.bin'), appImage())
    installGenericBoard()
    // Its copy would replace the one being flashed
    const clash = plan_(
      await resolveFlashPlan({
        port: '/dev/null',
        deviceFirmware,
        deviceBoard: onGeneric('@boards/t-display'),
      }),
    )
    expect(diffs(clash)).toEqual([pathlib.join(bundled.dir, 'bootloader.bin'), 'skip'])
    expect(nameIn(clash.flasherArgs.files[1]!.filename)).toBe('boards/t-display')
  })

  it("doesn't diff the app with a guess when the device runs other firmware", async () => {
    writeFileSync(pathlib.join(bundled.dir, 'app.bin'), appImage())
    const bootloader = pathlib.join(bundled.dir, 'bootloader.bin')
    const generic = {port: '/dev/null', chip: 'esp32c6' as const}
    for (const device of [
      // Not read (--force), or too old to report a version
      {},
      {deviceFirmware: {...deviceFirmware, version: '0.20.0'}},
      {deviceFirmware: {...deviceFirmware, name: 'my-firmware'}},
      // Another image: this one lists no features
      {deviceFirmware, deviceFeatures: ['wifi']},
    ]) {
      expect(diffs(plan_(await resolveFlashPlan({...generic, ...device})))).toEqual([
        bootloader,
        'skip',
      ])
    }
  })

  it("diffs a board's own image with itself when the device runs it", async () => {
    const ring = installBoards(tempDir)
    const image = pathlib.join(ring, 'dist-fw/full')
    const plan = plan_(
      await resolveFlashPlan({
        port: '/dev/null',
        board: 'ring',
        deviceFirmware: {name: 'ring', version: '0.21.0'},
      }),
    )
    expect(diffs(plan)).toEqual([
      pathlib.join(image, 'bootloader.bin'),
      pathlib.join(image, 'app.bin'),
    ])
  })

  it("flashes the board's image --features asks for, else the one the device runs", async () => {
    const ring = installBoards(tempDir)
    // The no-ble image beside full/, found by its folder
    const lean = pathlib.join(ring, 'dist-fw', 'no-ble')
    writeImage(lean, 'ring')
    const features = (dir: string, list: string[]) =>
      write(
        pathlib.join(dir, 'firmware.json'),
        JSON.stringify({name: 'ring', chip: 'esp32c6', version: '0.21.0', features: list}),
      )
    features(pathlib.join(ring, 'dist-fw', 'full'), ['wifi', 'ble'])
    features(lean, ['wifi'])
    const app = (plan: FlashPlan) => plan.flasherArgs.files.map((f) => f.filename).at(-1)

    const needs = plan_(
      await resolveFlashPlan({port: '/dev/null', board: 'ring', features: ['wifi']}),
    )
    expect(needs.chosenImage).toEqual({name: 'no-ble', source: 'features'})
    expect(app(needs)).toBe(pathlib.join(lean, 'app.bin'))

    const kept = plan_(
      await resolveFlashPlan({port: '/dev/null', board: 'ring', deviceFeatures: ['wifi']}),
    )
    expect(kept.chosenImage).toEqual({name: 'no-ble', source: 'device'})
    expect(app(kept)).toBe(pathlib.join(lean, 'app.bin'))

    const full = plan_(
      await resolveFlashPlan({port: '/dev/null', board: 'ring', deviceFeatures: ['wifi', 'ble']}),
    )
    expect(full.chosenImage).toBeUndefined()
    expect(app(full)).toBe(pathlib.join(ring, 'dist-fw', 'full', 'app.bin'))

    const back = plan_(
      await resolveFlashPlan({
        port: '/dev/null',
        board: 'ring',
        features: ['full'],
        deviceFeatures: ['wifi'],
      }),
    )
    expect(back.chosenImage).toEqual({name: 'full', source: 'features'})
    expect(app(back)).toBe(pathlib.join(ring, 'dist-fw', 'full', 'app.bin'))

    // A URL names one archive, so there is nothing to pick
    await expect(
      resolveFlashPlan({
        port: '/dev/null',
        board: 'ring',
        from: 'https://example.com/mikro-fw-ring.tar.gz',
        features: ['wifi'],
      }),
    ).rejects.toThrow('--from flashes the archive at that URL as it is')
  })

  it('flashes the bundled image of the chip', async () => {
    const plan = plan_(await resolveFlashPlan({port: '/dev/null', chip: 'esp32c6'}))
    expect(plan.image).toBe('bundled')
    expect(plan.board).toEqual({name: 'esp32c6-generic', source: 'detected'})
    expect(plan.flasherArgs.files.map((f) => f.filename)).toContain(
      pathlib.join(bundled.dir, 'app.bin'),
    )
  })

  it('says so when this CLI has no bundled image for the chip', async () => {
    await expect(resolveFlashPlan({port: '/dev/null', chip: 'esp32s3'})).rejects.toThrow(
      'No bundled firmware for esp32s3.',
    )
  })

  it('asks which board only when a picker can answer', async () => {
    installBoards(tempDir)
    const choice = await resolveFlashPlan({port: '/dev/null', chip: 'esp32c6', pickBoard: true})
    expect('choose' in choice && choice.choose.map((b) => b.name)).toEqual(['plain', 'ring'])
  })

  it('stops and lists the boards for the chip without a picker', async () => {
    installBoards(tempDir)
    await expect(resolveFlashPlan({port: '/dev/null', chip: 'esp32c6'})).rejects.toThrow(
      /^Several boards for esp32c6 are installed; choose one:\n {2}mikro flash --board plain\n {2}mikro flash --board ring\n/,
    )
  })

  it("flashes the only board for the device's chip", async () => {
    installBoards(tempDir)
    writeImage(pathlib.join(tempDir, 'node_modules/plain/dist-fw/full'), 'plain', 'esp32s3')
    const plan = plan_(
      await resolveFlashPlan({port: '/dev/null', chip: 'esp32c6', pickBoard: true}),
    )
    expect(plan.image).toBe('board')
    expect(plan.board).toEqual({name: 'ring', source: 'chip'})
  })

  it("stops when none of the boards is for the device's chip", async () => {
    installBoards(tempDir)
    await expect(resolveFlashPlan({port: '/dev/null', chip: 'esp32s3'})).rejects.toThrow(
      'None of the installed boards is for the esp32s3 on /dev/null:\n  plain (esp32c6)\n  ring (esp32c6)\n' +
        'Pass --board esp32s3-generic to flash the generic firmware.',
    )
  })

  it('leaves every board to choose from when the chip is unknown', async () => {
    installBoards(tempDir)
    // No --chip, and chip detection fails without esptool
    const choice = await resolveFlashPlan({port: '/dev/null', pickBoard: true})
    expect('choose' in choice && choice.choose.map((b) => b.name)).toEqual(['plain', 'ring'])
    await expect(resolveFlashPlan({port: '/dev/null'})).rejects.toThrow(
      /^Several boards are installed; choose one:/,
    )
  })

  it("warns when a workspace board's image is older than its last build", async () => {
    // The board package is in the workspace, with the build `mikro fw build` left
    const pkg = pathlib.join(tempDir, 'boards/ring')
    write(
      pathlib.join(pkg, 'package.json'),
      JSON.stringify({name: 'ring', exports: {'.': {firmware: './dist-fw/firmware.json'}}}),
    )
    writeImage(pathlib.join(pkg, 'dist-fw'), 'ring')
    write(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', dependencies: {ring: 'workspace:*'}}),
    )
    mkdirSync(pathlib.join(tempDir, 'node_modules'))
    symlinkSync(pkg, pathlib.join(tempDir, 'node_modules/ring'))
    const built = pathlib.join(pkg, '.mikro/build-fw/app.bin')
    write(built, 'newer')
    const later = new Date(Date.now() + 60_000)
    utimesSync(built, later, later)

    const plan = plan_(await resolveFlashPlan({port: '/dev/null'}))
    expect(plan.warnings).toEqual([
      expect.stringMatching(/^the image of ring is older than its last build in /),
    ])
  })

  it("skips a dependency's firmware export that isn't a board, with a warning", async () => {
    write(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', dependencies: {'other-tool': '*'}}),
    )
    const other = pathlib.join(tempDir, 'node_modules/other-tool')
    write(
      pathlib.join(other, 'package.json'),
      JSON.stringify({name: 'other-tool', exports: {firmware: './fw.json'}}),
    )
    write(pathlib.join(other, 'fw.json'), JSON.stringify({target: 'nrf52'}))
    const plan = plan_(await resolveFlashPlan({port: '/dev/null', chip: 'esp32c6'}))
    expect(plan.image).toBe('bundled')
    expect(plan.warnings).toEqual([expect.stringMatching(/^skipped other-tool: .*\(name\)/)])
  })

  it('flashes the archive at a --from URL, and takes nothing but a URL', async () => {
    downloaded.dir = pathlib.join(tempDir, 'download')
    downloaded.calls = []
    writeImage(downloaded.dir, 'my-firmware')
    const url = 'https://example.com/mikro-fw-my-firmware-esp32c6.tar.gz'
    const plan = plan_(await resolveFlashPlan({port: '/dev/null', from: url}))
    expect(plan.image).toBe('from')
    expect(plan.board).toBeUndefined()
    expect(downloaded.calls).toEqual([url])
    // A version, a ref or a repo is no URL
    for (const from of ['v0.21.0', 'main', 'my-org/my-firmware']) {
      await expect(resolveFlashPlan({port: '/dev/null', from})).rejects.toThrow(
        '--from takes the URL of a firmware archive',
      )
    }
    // --board picked an archive of several; now there is only the one at the URL
    await expect(
      resolveFlashPlan({port: '/dev/null', from: url, board: 'my-firmware'}),
    ).rejects.toThrow('--from flashes the archive at that URL as it is')
    // Firmware for another chip
    writeImage(downloaded.dir, 'my-firmware', 'esp32s3')
    await expect(resolveFlashPlan({port: '/dev/null', from: url, chip: 'esp32c6'})).rejects.toThrow(
      `${url} is firmware for esp32s3, and the device is an esp32c6.`,
    )
    // An installed board's name
    await expect(
      resolveFlashPlan({port: '/dev/null', board: 'my-firmware', chip: 'esp32c6'}),
    ).rejects.toThrow("Unknown board 'my-firmware'.")
  })

  it("leaves a board's own image to mikro flash in the automatic reflash", async () => {
    installBoards(tempDir)
    await expect(flashFirmware({port: '/dev/null', board: 'ring'})).rejects.toThrow(
      'ring ships firmware of its own, so it is not flashed automatically',
    )
  })
})
