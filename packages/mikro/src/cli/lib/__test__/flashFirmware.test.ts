import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {UserError} from '../errorMessage.js'
import {assertFilesystemKept, type FlashPlan} from '../flashFirmware.js'

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
})
