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

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {flashFirmware, type FlashPlan, resolveFlashPlan} from '../flashFirmware.js'

// No real esptool: chip detection fails, which the plan treats as "unknown"
// and falls back to the board's or --target's chip.
vi.mock('@mikrojs/esptool', () => ({getEsptoolPath: async () => '/nonexistent/esptool'}))

// `--from` without the network: the download is the image in `downloaded.dir`.
const downloaded = vi.hoisted(() => ({dir: '', calls: [] as unknown[]}))
vi.mock('../firmware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../firmware.js')>()),
  resolveFrom: async (options: unknown) => {
    downloaded.calls.push(options)
    return downloaded.dir
  },
}))

// The bundled esp32c6 image, whether or not the workspace has built one.
const bundled = vi.hoisted(() => ({dir: ''}))
vi.mock('@mikrojs/firmware/boards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mikrojs/firmware/boards')>()
  return {
    ...actual,
    genericBoards: () => ({
      boards: [
        {
          name: 'esp32c6-generic',
          chip: 'esp32c6',
          version: '0.21.0',
          specifier: '@mikrojs/firmware/esp32c6-generic',
          packageName: '@mikrojs/firmware',
          packageDir: bundled.dir,
          dir: bundled.dir,
        },
      ],
      problems: [],
    }),
  }
})

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
      JSON.stringify({name, exports: {'.': {firmware: './dist-fw/firmware.json'}}}),
    )
    writeImage(pathlib.join(pkg, 'dist-fw'), name)
  }
  return pathlib.join(dir, 'node_modules/ring')
}

/** The plan, when it is one rather than a choice of boards. */
function plan_(result: FlashPlan | {choose: unknown}): FlashPlan {
  if ('choose' in result) throw new Error('expected a plan, got a choice of boards')
  return result
}

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
  })

  it('flashes the image a board package ships', async () => {
    const ring = installBoards(tempDir)
    const plan = plan_(await resolveFlashPlan({port: '/dev/null', board: 'ring'}))
    expect(plan.image).toBe('board')
    expect(plan.board).toEqual({name: 'ring', source: 'flag'})
    expect(plan.flasherArgs.files.map((f) => f.filename)).toEqual([
      pathlib.join(ring, 'dist-fw/bootloader.bin'),
      pathlib.join(ring, 'dist-fw/app.bin'),
    ])
  })

  it('flashes the bundled image of the chip', async () => {
    const plan = plan_(await resolveFlashPlan({port: '/dev/null', target: 'esp32c6'}))
    expect(plan.image).toBe('bundled')
    expect(plan.board).toEqual({name: 'esp32c6-generic', source: 'detected'})
    expect(plan.flasherArgs.files.map((f) => f.filename)).toContain(
      pathlib.join(bundled.dir, 'app.bin'),
    )
  })

  it('says so when this CLI has no bundled image for the chip', async () => {
    await expect(resolveFlashPlan({port: '/dev/null', target: 'esp32s3'})).rejects.toThrow(
      'No bundled firmware for esp32s3.',
    )
  })

  it('asks which board only when a picker can answer', async () => {
    installBoards(tempDir)
    const choice = await resolveFlashPlan({port: '/dev/null', target: 'esp32c6', pickBoard: true})
    expect('choose' in choice && choice.choose.map((b) => b.name)).toEqual(['plain', 'ring'])
  })

  it('stops and lists the boards for the chip without a picker', async () => {
    installBoards(tempDir)
    await expect(resolveFlashPlan({port: '/dev/null', target: 'esp32c6'})).rejects.toThrow(
      /^Several boards for esp32c6 are installed; choose one:\n {2}mikro flash --board plain\n {2}mikro flash --board ring\n/,
    )
  })

  it("flashes the only board for the device's chip", async () => {
    installBoards(tempDir)
    writeImage(pathlib.join(tempDir, 'node_modules/plain/dist-fw'), 'plain', 'esp32s3')
    const plan = plan_(
      await resolveFlashPlan({port: '/dev/null', target: 'esp32c6', pickBoard: true}),
    )
    expect(plan.image).toBe('board')
    expect(plan.board).toEqual({name: 'ring', source: 'chip'})
  })

  it("stops when none of the boards is for the device's chip", async () => {
    installBoards(tempDir)
    await expect(resolveFlashPlan({port: '/dev/null', target: 'esp32s3'})).rejects.toThrow(
      'None of the installed boards is for the esp32s3 on /dev/null:\n  plain (esp32c6)\n  ring (esp32c6)\n' +
        'Pass --board esp32s3-generic to flash the generic firmware.',
    )
  })

  it('leaves every board to choose from when the chip is unknown', async () => {
    installBoards(tempDir)
    // No --target, and chip detection fails without esptool
    const choice = await resolveFlashPlan({port: '/dev/null', pickBoard: true})
    expect('choose' in choice && choice.choose.map((b) => b.name)).toEqual(['plain', 'ring'])
    await expect(resolveFlashPlan({port: '/dev/null'})).rejects.toThrow(
      /^Several boards are installed; choose one:/,
    )
  })

  it("warns when a workspace board's image is older than its last build", async () => {
    // The board package is in the workspace, with its firmware project
    const pkg = pathlib.join(tempDir, 'boards/ring')
    write(
      pathlib.join(pkg, 'package.json'),
      JSON.stringify({name: 'ring', exports: {'.': {firmware: './dist-fw/firmware.json'}}}),
    )
    write(pathlib.join(pkg, 'CMakeLists.txt'), '')
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
      expect.stringMatching(/^the image of ring is older than the last build in /),
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
    const plan = plan_(await resolveFlashPlan({port: '/dev/null', target: 'esp32c6'}))
    expect(plan.image).toBe('bundled')
    expect(plan.warnings).toEqual([expect.stringMatching(/^skipped other-tool: .*\(name\)/)])
  })

  it('takes any --board name with --from, to pick the archive', async () => {
    downloaded.dir = pathlib.join(tempDir, 'download')
    downloaded.calls = []
    writeImage(downloaded.dir, 'my-firmware')
    const plan = plan_(
      await resolveFlashPlan({
        port: '/dev/null',
        from: 'my-org/my-firmware',
        board: 'my-firmware',
        target: 'esp32c6',
      }),
    )
    expect(plan.image).toBe('from')
    expect(plan.board).toEqual({name: 'my-firmware', source: 'flag'})
    expect(downloaded.calls).toEqual([
      expect.objectContaining({from: 'my-org/my-firmware', board: 'my-firmware', chip: 'esp32c6'}),
    ])
    // A release without the board's archive: the plan says what it flashes
    writeImage(downloaded.dir, 'esp32c6-generic')
    const fallback = plan_(
      await resolveFlashPlan({
        port: '/dev/null',
        from: 'mikrojs/mikro',
        board: 'my-firmware',
        target: 'esp32c6',
      }),
    )
    expect(fallback.board).toEqual({name: 'esp32c6-generic', source: 'detected'})
    expect(fallback.warnings).toEqual([
      'mikrojs/mikro has no firmware for my-firmware; this flashes esp32c6-generic',
    ])
    // Without --from, the name must be an installed board
    await expect(
      resolveFlashPlan({port: '/dev/null', board: 'my-firmware', target: 'esp32c6'}),
    ).rejects.toThrow("Unknown board 'my-firmware'.")
  })

  it("leaves a board's own image to mikro flash in the automatic reflash", async () => {
    installBoards(tempDir)
    await expect(flashFirmware({port: '/dev/null', board: 'ring'})).rejects.toThrow(
      'ring ships firmware of its own, so it is not flashed automatically',
    )
  })
})
