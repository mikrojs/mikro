import {createHash} from 'node:crypto'

/**
 * A small ESP-IDF app image, laid out as esptool's elf2image writes one: the
 * 24-byte header, a first segment that starts with esp_app_desc_t (256 bytes)
 * and the firmware's board name slot, a second segment, padding, the checksum
 * and, when `hash`, the SHA-256 of all that.
 */
export function appImage({slot = true, hash = true} = {}): Uint8Array {
  const desc = new Uint8Array(0x100 + 4 + 64 + 12).fill(0x5a)
  desc.fill(0, 0x100)
  if (slot) new DataView(desc.buffer).setUint32(0x100, 0x424b494d, true)
  const segments = [desc, Uint8Array.from({length: 40}, (_, i) => i)]

  const header = new Uint8Array(24)
  header[0] = 0xe9
  header[1] = segments.length
  header[23] = hash ? 1 : 0
  const parts: Uint8Array[] = [header]
  let checksum = 0xef
  for (const data of segments) {
    const segmentHeader = new Uint8Array(8)
    new DataView(segmentHeader.buffer).setUint32(4, data.length, true)
    parts.push(segmentHeader, data)
    for (const byte of data) checksum ^= byte
  }
  const length = parts.reduce((n, p) => n + p.length, 0)
  const tail = new Uint8Array(16 - (length % 16))
  tail[tail.length - 1] = checksum
  parts.push(tail)
  const image = Buffer.concat(parts)
  return hash ? Buffer.concat([image, createHash('sha256').update(image).digest()]) : image
}
