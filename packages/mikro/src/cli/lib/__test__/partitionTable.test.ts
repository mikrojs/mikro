import {describe, expect, it} from 'vitest'

import {filesystemLoss, parsePartitionTable} from '../partitionTable.js'

// gen_esp32part.py output for a partitions.csv with user = 0x100000, cut
// after the MD5 entry. The rest is erased flash.
const STOCK = Buffer.from(
  'aa50010200900000006000006e76730000000000000000000000000000000000' +
    'aa50010100f00000001000007068795f696e6974000000000000000000000000' +
    'aa5000000000010000002800666163746f727900000000000000000000000000' +
    'aa50018300002900000010007573657200000000000000000000000000000000' +
    'ebebffffffffffffffffffffffffffffebf4c8066990467b8a4bb262a8dd2580' +
    'ff'.repeat(64),
  'hex',
)
const USER_ENTRY = 3

function withUser(size: number, offset = 0x290000): Uint8Array {
  const table = Uint8Array.from(STOCK)
  const view = new DataView(table.buffer)
  view.setUint32(USER_ENTRY * 32 + 4, offset, true)
  view.setUint32(USER_ENTRY * 32 + 8, size, true)
  return table
}

function withoutUser(): Uint8Array {
  // Drop the user entry by moving the MD5 entry and erased flash up over it.
  const table = new Uint8Array(STOCK.length).fill(0xff)
  table.set(STOCK.subarray(0, USER_ENTRY * 32))
  table.set(STOCK.subarray((USER_ENTRY + 1) * 32), USER_ENTRY * 32)
  return table
}

const ERASED = new Uint8Array(0xc00).fill(0xff)

describe('parsePartitionTable', () => {
  it('reads labels, offsets and sizes up to the MD5 entry', () => {
    expect(parsePartitionTable(STOCK)).toEqual([
      {label: 'nvs', offset: 0x9000, size: 0x6000},
      {label: 'phy_init', offset: 0xf000, size: 0x1000},
      {label: 'factory', offset: 0x10000, size: 0x280000},
      {label: 'user', offset: 0x290000, size: 0x100000},
    ])
  })

  it('finds no entries on erased flash', () => {
    expect(parsePartitionTable(ERASED)).toEqual([])
  })

  it('reads a label that fills all 16 bytes', () => {
    const table = Uint8Array.from(STOCK)
    table.set(new TextEncoder().encode('abcdefghijklmnop'), 12)
    expect(parsePartitionTable(table)[0]!.label).toBe('abcdefghijklmnop')
  })
})

const USER = {label: 'user', offset: 0x290000, size: 0x100000}

describe('filesystemLoss', () => {
  it('reports a smaller user partition', () => {
    expect(filesystemLoss(withUser(0x170000), STOCK)).toEqual({
      from: {...USER, size: 0x170000},
      to: USER,
    })
  })

  it('reports a user partition that moves, even when it grows', () => {
    // A board image with a 3 MB factory, then the generic firmware
    expect(filesystemLoss(withUser(0x4f0000, 0x310000), withUser(0x570000))).toEqual({
      from: {...USER, offset: 0x310000, size: 0x4f0000},
      to: {...USER, size: 0x570000},
    })
  })

  it('passes a user partition that keeps its place and size or grows', () => {
    expect(filesystemLoss(STOCK, STOCK)).toBeUndefined()
    expect(filesystemLoss(STOCK, withUser(0x170000))).toBeUndefined()
  })

  it('passes a blank device', () => {
    expect(filesystemLoss(ERASED, STOCK)).toBeUndefined()
  })

  it('passes a device without a user partition', () => {
    expect(filesystemLoss(withoutUser(), STOCK)).toBeUndefined()
  })

  it('reports a new table without a user partition', () => {
    expect(filesystemLoss(STOCK, withoutUser())).toEqual({from: USER, to: undefined})
  })
})
