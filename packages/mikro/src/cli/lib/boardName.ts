import {createHash} from 'node:crypto'

/** The firmware's board name slot (MIKBoardDesc in mik_sys.cpp): ESP-IDF's
 *  .rodata_custom_desc, after the image header (24 bytes), the first segment's
 *  header (8) and esp_app_desc_t (256). A magic number, then 64 bytes. */
const BOARD_DESC_OFFSET = 0x120
const BOARD_DESC_MAGIC = 0x424b494d // "MIKB"
const BOARD_NAME_OFFSET = BOARD_DESC_OFFSET + 4
const BOARD_NAME_SIZE = 64

const IMAGE_MAGIC = 0xe9
const HEADER_SIZE = 24
const SEGMENT_HEADER_SIZE = 8
const HASH_APPENDED_OFFSET = 23
const CHECKSUM_SEED = 0xef
const SHA256_SIZE = 32

/** Where an ESP-IDF app image keeps its checksum, after the segments and
 *  padding to 16 bytes, and the checksum its segments give. Undefined when
 *  the segments run past the end. */
function checksumOf(image: Uint8Array): {offset: number; value: number} | undefined {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength)
  let pos = HEADER_SIZE
  let value = CHECKSUM_SEED
  for (let segment = 0; segment < image[1]!; segment++) {
    if (pos + SEGMENT_HEADER_SIZE > image.length) return undefined
    const length = view.getUint32(pos + 4, true)
    pos += SEGMENT_HEADER_SIZE
    if (pos + length > image.length) return undefined
    for (let i = pos; i < pos + length; i++) value ^= image[i]!
    pos += length
  }
  const offset = pos + 15 - (pos % 16)
  return offset < image.length ? {offset, value} : undefined
}

/**
 * A copy of the app image `image` with `name` in its board name slot, and its
 * checksum and SHA-256 recomputed so the bootloader accepts it. Refuses an
 * image whose checksum or hash doesn't check out before the change, or that
 * has no slot (built before the firmware had one).
 */
export function writeBoardName(
  image: Uint8Array,
  name: string,
): {ok: true; value: Uint8Array} | {ok: false; message: string} {
  const encoded = new TextEncoder().encode(name)
  if (encoded.length >= BOARD_NAME_SIZE) {
    return {
      ok: false,
      message: `the board name "${name}" is longer than ${BOARD_NAME_SIZE - 1} bytes`,
    }
  }
  const checksum = image[0] === IMAGE_MAGIC ? checksumOf(image) : undefined
  if (checksum === undefined || image[checksum.offset] !== checksum.value) {
    return {ok: false, message: 'not an ESP-IDF app image, or a damaged one'}
  }
  const hashed = image[HASH_APPENDED_OFFSET] === 1
  const hashEnd = checksum.offset + 1
  if (hashed) {
    const stored = image.subarray(hashEnd, hashEnd + SHA256_SIZE)
    const actual = createHash('sha256').update(image.subarray(0, hashEnd)).digest()
    if (stored.length !== SHA256_SIZE || !actual.equals(stored)) {
      return {ok: false, message: 'the app image does not match its SHA-256'}
    }
  }
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength)
  const firstSegment = view.getUint32(HEADER_SIZE + 4, true)
  if (
    HEADER_SIZE + SEGMENT_HEADER_SIZE + firstSegment < BOARD_NAME_OFFSET + BOARD_NAME_SIZE ||
    view.getUint32(BOARD_DESC_OFFSET, true) !== BOARD_DESC_MAGIC
  ) {
    return {ok: false, message: 'the firmware has no place for a board name'}
  }

  const patched = Uint8Array.from(image)
  patched.fill(0, BOARD_NAME_OFFSET, BOARD_NAME_OFFSET + BOARD_NAME_SIZE)
  patched.set(encoded, BOARD_NAME_OFFSET)
  patched[checksum.offset] = checksumOf(patched)!.value
  if (hashed) {
    patched.set(createHash('sha256').update(patched.subarray(0, hashEnd)).digest(), hashEnd)
  }
  return {ok: true, value: patched}
}
