import {createHash} from 'node:crypto'

/** Where ESP-IDF keeps the partition table in flash, and its maximum length. */
export const PARTITION_TABLE_OFFSET = 0x8000
export const PARTITION_TABLE_SIZE = 0xc00

const ENTRY_SIZE = 32
const ENTRY_MAGIC = 0x50aa
const MD5_MAGIC = 0xebeb

interface Partition {
  label: string
  offset: number
  size: number
}

/** Entries of a binary ESP-IDF partition table. The table ends at its MD5 entry
 *  or at erased flash, so a blank device yields no entries. */
export function parsePartitionTable(bytes: Uint8Array): Partition[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries: Partition[] = []
  for (let pos = 0; pos + ENTRY_SIZE <= bytes.length; pos += ENTRY_SIZE) {
    if (view.getUint16(pos, true) !== ENTRY_MAGIC) break
    const label = bytes.subarray(pos + 12, pos + 28)
    const end = label.indexOf(0)
    entries.push({
      label: textDecoder.decode(end === -1 ? label : label.subarray(0, end)),
      offset: view.getUint32(pos + 4, true),
      size: view.getUint32(pos + 8, true),
    })
  }
  return entries
}

/**
 * The device's `user` partition and what `next` makes of it, when that loses
 * its files: `next` drops it, moves it or makes it smaller. The partition's
 * size stands in for the filesystem's, which the firmware grows to fill it.
 */
export function filesystemLoss(
  current: Uint8Array,
  next: Uint8Array,
): {from: Partition; to: Partition | undefined} | undefined {
  const from = userPartition(current)
  if (!from) return undefined
  const to = userPartition(next)
  if (to && to.offset === from.offset && to.size >= from.size) return undefined
  return {from, to}
}

/**
 * A copy of `table` with the `user` partition stretched to end at `flashSize`,
 * and the MD5 entry recomputed. Undefined unless `user` is the last partition
 * and ends before `flashSize`.
 */
export function growFilesystemToFlash(
  table: Uint8Array,
  flashSize: number,
): Uint8Array | undefined {
  const partitions = parsePartitionTable(table)
  const count = partitions.length
  const last = count - 1
  const user = partitions[last]
  if (user?.label !== 'user' || user.offset + user.size >= flashSize) return undefined

  const grown = Uint8Array.from(table)
  const view = new DataView(grown.buffer)
  view.setUint32(last * ENTRY_SIZE + 8, flashSize - user.offset, true)

  // The bootloader rejects the table if its MD5 entry no longer matches.
  const md5 = count * ENTRY_SIZE
  if (md5 + ENTRY_SIZE <= grown.length && view.getUint16(md5, true) === MD5_MAGIC) {
    grown.set(createHash('md5').update(grown.subarray(0, md5)).digest(), md5 + 16)
  }
  return grown
}

function userPartition(table: Uint8Array): Partition | undefined {
  return parsePartitionTable(table).find((p) => p.label === 'user')
}

export function userSize(table: Uint8Array): number | undefined {
  return userPartition(table)?.size
}

const textDecoder = new TextDecoder()
