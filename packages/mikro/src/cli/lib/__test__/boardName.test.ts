import {describe, expect, it} from 'vitest'

import {writeBoardName} from '../boardName.js'
import {appImage} from './appImage.js'

const NAME_OFFSET = 0x124

function nameIn(image: Uint8Array): string {
  const field = image.subarray(NAME_OFFSET, NAME_OFFSET + 64)
  return new TextDecoder().decode(field.subarray(0, field.indexOf(0)))
}

describe('writeBoardName', () => {
  it('writes the name into the slot, and a checksum and hash that check out', () => {
    const image = appImage()
    const written = writeBoardName(image, '@acme/boards/t-display')
    if (!written.ok) throw new Error(written.message)
    expect(nameIn(written.value)).toBe('@acme/boards/t-display')
    // Only the slot changed, besides the checksum and hash at the end
    expect(Buffer.from(written.value.subarray(0, NAME_OFFSET))).toEqual(
      Buffer.from(image.subarray(0, NAME_OFFSET)),
    )
    expect(written.value.length).toBe(image.length)

    // Written again over it: the checksum and hash it wrote are the ones it checks
    const again = writeBoardName(written.value, 'xiao')
    if (!again.ok) throw new Error(again.message)
    expect(nameIn(again.value)).toBe('xiao')
    expect(again.value.subarray(NAME_OFFSET + 4, NAME_OFFSET + 64).every((b) => b === 0)).toBe(true)
  })

  it('writes an image without a hash', () => {
    const written = writeBoardName(appImage({hash: false}), 'xiao')
    if (!written.ok) throw new Error(written.message)
    expect(nameIn(written.value)).toBe('xiao')
    expect(writeBoardName(written.value, 'xiao').ok).toBe(true)
  })

  it('refuses firmware without the slot, a damaged image and a name that does not fit', () => {
    expect(writeBoardName(appImage({slot: false}), 'xiao')).toEqual({
      ok: false,
      message: 'the firmware has no place for a board name',
    })
    const damaged = appImage()
    damaged[0x40]! ^= 1
    expect(writeBoardName(damaged, 'xiao')).toEqual({
      ok: false,
      message: 'not an ESP-IDF app image, or a damaged one',
    })
    const rehashed = appImage()
    rehashed[rehashed.length - 1]! ^= 1
    expect(writeBoardName(rehashed, 'xiao')).toEqual({
      ok: false,
      message: 'the app image does not match its SHA-256',
    })
    expect(writeBoardName(new Uint8Array(64), 'xiao').ok).toBe(false)
    expect(writeBoardName(appImage(), 'x'.repeat(64))).toEqual({
      ok: false,
      message: `the board name "${'x'.repeat(64)}" is longer than 63 bytes`,
    })
  })
})
