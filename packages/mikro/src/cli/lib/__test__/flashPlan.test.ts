import {
  chmodSync,
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

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
  chooseImage,
  flashFirmware,
  type FlashPlan,
  parseFeatures,
  resolveFlashPlan,
} from '../flashFirmware.js'

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
})

describe('resolveFlashPlan', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'flash-plan-')))
    process.chdir(tempDir)
    bundled.dir = pathlib.join(tempDir, 'bundled')
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
