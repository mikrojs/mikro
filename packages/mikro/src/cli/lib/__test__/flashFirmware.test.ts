import {writeFileSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {UserError} from '../errorMessage.js'
import {
  assertFilesystemKept,
  flashFirmware,
  type FlashPlan,
  resolveFlashPlan,
} from '../flashFirmware.js'
import {growFilesystemToFlash, parsePartitionTable} from '../partitionTable.js'

const {execFile, firmwareDir, installed, cache} = vi.hoisted(() => ({
  execFile: vi.fn(),
  firmwareDir: {current: ''},
  // The CLI's cache folder, where grown partition tables go.
  cache: {current: ''},
  // Board packages in the project's dependencies.
  installed: {boards: [] as unknown[]},
}))
vi.mock('node:child_process', () => ({execFile}))
vi.mock('@mikrojs/esptool', () => ({getEsptoolPath: async () => '/fixture/esptool'}))
vi.mock('../boards.js', () => ({
  bundledBoards: () => [
    {name: 'esp32c6-generic', chip: 'esp32c6', bundled: true, dir: firmwareDir.current},
  ],
  discoverBoards: async () => ({boards: installed.boards, problems: []}),
  staleImage: () => undefined,
}))
vi.mock('../firmware.js', () => ({resolveFrom: async () => firmwareDir.current}))
vi.mock('../envPaths.js', () => ({
  paths: {
    get cache() {
      return cache.current
    },
  },
}))

function tableWithUser(size: number, offset = 0x290000): Uint8Array {
  const table = new Uint8Array(0xc00).fill(0xff)
  const view = new DataView(table.buffer)
  view.setUint16(0, 0x50aa, true)
  view.setUint32(4, offset, true)
  view.setUint32(8, size, true)
  table.fill(0, 12, 32)
  table.set(new TextEncoder().encode('user'), 12)
  return table
}

describe('assertFilesystemKept', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mikro-flash-test-'))
    execFile.mockReset()
  })
  afterEach(async () => {
    await fs.rm(dir, {recursive: true, force: true})
  })

  async function plan(device: Uint8Array, next: Uint8Array): Promise<FlashPlan> {
    const filename = path.join(dir, 'partition-table.bin')
    await fs.writeFile(filename, next)
    return {
      esptoolPath: '/fixture/esptool',
      flasherArgs: {
        chip: 'esp32c6',
        files: [
          {address: 0x0, filename: path.join(dir, 'bootloader.bin')},
          {address: 0x8000, filename},
          {address: 0x10000, filename: path.join(dir, 'mikrojs.bin')},
        ],
      } as FlashPlan['flasherArgs'],
      image: 'bundled',
      warnings: [],
      devicePartitionTable: device,
    }
  }

  it('refuses a table that shrinks the app filesystem, naming the loss and --force', async () => {
    const p = await plan(tableWithUser(0x170000), tableWithUser(0x100000))
    const refusal = assertFilesystemKept(p, '/dev/tty.fixture')
    await expect(refusal).rejects.toBeInstanceOf(UserError)
    await expect(refusal).rejects.toThrow(
      'This firmware shrinks the app filesystem from 1.4 MB to 1.0 MB, 448.0 KB less. ' +
        "The filesystem would be reformatted and the app's files on it lost. " +
        'Re-run with --force to flash anyway.',
    )
  })

  it('refuses a table that moves the app filesystem, even when it grows', async () => {
    const p = await plan(tableWithUser(0x4f0000, 0x310000), tableWithUser(0x570000))
    await expect(assertFilesystemKept(p, '/dev/tty.fixture')).rejects.toThrow(
      'This firmware moves the app filesystem from 0x310000 to 0x290000. ' +
        "The filesystem would be reformatted and the app's files on it lost.",
    )
  })

  it('passes a table that keeps the app filesystem size', async () => {
    const p = await plan(tableWithUser(0x100000), tableWithUser(0x170000))
    await expect(assertFilesystemKept(p, '/dev/tty.fixture')).resolves.toBeUndefined()
  })

  it('passes firmware that writes no partition table', async () => {
    const p = await plan(tableWithUser(0x170000), tableWithUser(0x100000))
    p.flasherArgs.files = p.flasherArgs.files.filter((f) => f.address !== 0x8000)
    await expect(assertFilesystemKept(p, '/dev/tty.fixture')).resolves.toBeUndefined()
  })

  it('reads the device only when the plan has no partition table of it', async () => {
    const p = await plan(tableWithUser(0x100000), tableWithUser(0x170000))
    await assertFilesystemKept(p, '/dev/tty.fixture')
    expect(execFile).not.toHaveBeenCalled()

    execFile.mockImplementation(
      (_file: string, args: string[], cb: (err: null, out: {stdout: string}) => void) => {
        writeFileSync(args.at(-1)!, tableWithUser(0x200000))
        cb(null, {stdout: 'Detecting chip type... ESP32-C6\n'})
      },
    )
    delete p.devicePartitionTable
    await expect(assertFilesystemKept(p, '/dev/tty.fixture')).rejects.toThrow(
      'This firmware shrinks the app filesystem from 2.0 MB to 1.4 MB',
    )
    expect(execFile).toHaveBeenCalledTimes(1)
  })
})

// gen_esp32part.py output for packages/@mikrojs/firmware/partitions.csv, whose
// `user` partition (0x290000 + 0x170000) ends at the 4 MB the build is for.
const GENERIC_TABLE = Buffer.from(
  'aa50010200900000006000006e76730000000000000000000000000000000000' +
    'aa50010100f00000001000007068795f696e6974000000000000000000000000' +
    'aa5000000000010000002800666163746f727900000000000000000000000000' +
    'aa50018300002900000017007573657200000000000000000000000000000000' +
    'ebebfffffffffffffffffffffffffffff3e0bd92ae3dd1634ea63380c5a5ea87',
  'hex',
)

describe('resolveFlashPlan', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mikro-flash-plan-test-'))
    firmwareDir.current = dir
    cache.current = path.join(dir, 'cache')
    await firmware(GENERIC_TABLE)
    execFile.mockReset()
    installed.boards = []
  })
  afterEach(async () => {
    await fs.rm(dir, {recursive: true, force: true})
  })

  async function firmware(table: Uint8Array) {
    await fs.writeFile(path.join(dir, 'partition-table.bin'), table)
    await fs.writeFile(
      path.join(dir, 'flasher_args.json'),
      JSON.stringify({
        flash_files: {
          '0x0': 'bootloader.bin',
          '0x8000': 'partition-table.bin',
          '0x10000': 'mikrojs.bin',
        },
        flash_settings: {flash_mode: 'dio', flash_size: '4MB', flash_freq: '80m'},
        extra_esptool_args: {chip: 'esp32c6', before: 'default_reset', after: 'hard_reset'},
      }),
    )
  }

  /** A device whose esptool read-flash reports `flashSize` ("Auto-detected
   *  flash size: 8MB"), or no size when esptool doesn't recognise the chip. */
  function device(
    flashSize: string | undefined,
    {chip = 'ESP32-C6', table = GENERIC_TABLE}: {chip?: string; table?: Uint8Array} = {},
  ) {
    execFile.mockImplementation(
      (_file: string, args: string[], cb: (err: null, out: {stdout: string}) => void) => {
        writeFileSync(args.at(-1)!, table)
        cb(null, {
          stdout:
            `Detecting chip type... ${chip}\n` +
            (flashSize ? `Auto-detected flash size: ${flashSize}\n` : ''),
        })
      },
    )
  }

  async function planFor(opts: Parameters<typeof resolveFlashPlan>[0]): Promise<FlashPlan> {
    const plan = await resolveFlashPlan(opts)
    if ('choose' in plan) throw new Error('expected a plan, got a choice of boards')
    return plan
  }

  async function userSizeIn(plan: FlashPlan): Promise<number | undefined> {
    const table = plan.flasherArgs.files.find((f) => f.address === 0x8000)!
    return parsePartitionTable(await fs.readFile(table.filename)).at(-1)?.size
  }

  it("gives the bundled firmware's filesystem the rest of an 8 MB flash", async () => {
    device('8MB')
    const plan = await planFor({port: '/dev/tty.fixture'})
    expect(execFile.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--flash-size', 'detect']))
    expect(plan.flasherArgs.flashSize).toBe('8MB')
    expect(await userSizeIn(plan)).toBe(0x570000)
    expect(plan.filesystemSize).toBe(0x570000)
    // In the user's own cache, where another flash reuses it rather than leaving one more.
    expect(plan.flasherArgs.files[1]!.filename.startsWith(cache.current + path.sep)).toBe(true)
    const again = await planFor({port: '/dev/tty.fixture'})
    expect(again.flasherArgs.files[1]!.filename).toBe(plan.flasherArgs.files[1]!.filename)
  })

  it('does the same for --from firmware and a chip given with --target', async () => {
    device('8MB')
    const plan = await planFor({port: '/dev/tty.fixture', from: 'v1', target: 'esp32c6'})
    expect(plan.flasherArgs.flashSize).toBe('8MB')
    expect(plan.filesystemSize).toBe(0x570000)
  })

  it('stops at 16 MB', async () => {
    device('32MB')
    const plan = await planFor({port: '/dev/tty.fixture'})
    expect(plan.flasherArgs.flashSize).toBe('16MB')
    expect(plan.filesystemSize).toBe(0xd70000)
  })

  it('keeps the 4 MB layout on a 4 MB flash or one esptool cannot size', async () => {
    for (const size of ['4MB', undefined]) {
      device(size)
      const plan = await planFor({port: '/dev/tty.fixture'})
      expect(plan.flasherArgs.flashSize).toBe('4MB')
      expect(plan.flasherArgs.files[1]!.filename).toBe(path.join(dir, 'partition-table.bin'))
      expect(plan.filesystemSize).toBe(0x170000)
    }
  })

  it("grows a filesystem that stops short of the build's flash size", async () => {
    const table = Buffer.from(GENERIC_TABLE)
    table.writeUInt32LE(0x100000, 3 * 32 + 8)
    await firmware(table)
    device('8MB')
    const plan = await planFor({port: '/dev/tty.fixture'})
    expect(plan.flasherArgs.flashSize).toBe('8MB')
    expect(plan.filesystemSize).toBe(0x570000)
  })

  it('leaves a --build-dir build as it was built', async () => {
    device('8MB')
    const plan = await planFor({port: '/dev/tty.fixture', buildDir: dir})
    expect(execFile).not.toHaveBeenCalled()
    expect(plan.flasherArgs.flashSize).toBe('4MB')
    expect(plan.filesystemSize).toBe(0x170000)
  })

  it("grows a board package's image on a variant with more flash", async () => {
    installed.boards = [{name: 'acme', chip: 'esp32c6', dir}]
    device('8MB')
    const plan = await planFor({port: '/dev/tty.fixture', board: 'acme'})
    expect(plan.image).toBe('board')
    expect(plan.flasherArgs.flashSize).toBe('8MB')
    expect(plan.filesystemSize).toBe(0x570000)
  })

  it('stops a board for another chip than the one it read', async () => {
    device('8MB', {chip: 'ESP32-S3'})
    await expect(planFor({port: '/dev/tty.fixture', board: 'esp32c6-generic'})).rejects.toThrow(
      'esp32c6-generic is an esp32c6 board; the device on /dev/tty.fixture is an esp32s3.',
    )
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('keeps the automatic reflash from shrinking the app filesystem', async () => {
    // A grown device whose flash esptool cannot size this time: the plan keeps 4 MB.
    const grown = growFilesystemToFlash(GENERIC_TABLE, 0x800000)!
    device(undefined, {table: grown})
    await expect(flashFirmware({port: '/dev/tty.fixture'})).rejects.toThrow(
      'This firmware shrinks the app filesystem from 5.4 MB to 1.4 MB, 4.0 MB less. ' +
        "The filesystem would be reformatted and the app's files on it lost. " +
        'Run `mikro flash --force` to flash anyway.',
    )
    // The check reused the plan's read of the device, and nothing was flashed.
    expect(execFile).toHaveBeenCalledTimes(1)
  })
})
