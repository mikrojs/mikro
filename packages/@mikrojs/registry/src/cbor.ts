// Minimal CBOR codec (RFC 8949) for the check-in wire: maps with string keys,
// arrays, text and byte strings, integers, floats, bool/null/undefined.
// Definite lengths only — that is what the device's encoder (nanocbor) emits —
// and anything outside the subset throws rather than passing through mangled.
// Self-contained on purpose: the wire is small and stable, and a dependency is
// a bigger liability than these two functions.

const textEncoder = new TextEncoder()
// fatal so malformed UTF-8 in a text string throws instead of decoding to
// U+FFFD. Constructed through a cast because this file is also swept by a
// typecheck that sees the device runtime's TextDecoder, which has no options
// parameter; this code itself only ever runs on Node/Workers.
const textDecoder = new (TextDecoder as unknown as new (
  label: string,
  options: {fatal: boolean},
) => {decode(input?: Uint8Array): string})('utf-8', {fatal: true})

const MAX_DEPTH = 32

export function encodeCbor(value: unknown): Uint8Array {
  const parts: Uint8Array[] = []
  writeValue(parts, value, 0)
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function writeValue(parts: Uint8Array[], value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error('cbor: structure too deep')
  if (value === false) return writeByte(parts, 0xf4)
  if (value === true) return writeByte(parts, 0xf5)
  if (value === null) return writeByte(parts, 0xf6)
  if (value === undefined) return writeByte(parts, 0xf7)
  switch (typeof value) {
    case 'number': {
      if (Number.isSafeInteger(value)) {
        if (value >= 0) return writeTypeAndLength(parts, 0, value)
        return writeTypeAndLength(parts, 1, -(value + 1))
      }
      const buf = new Uint8Array(9)
      buf[0] = 0xfb
      new DataView(buf.buffer).setFloat64(1, value)
      parts.push(buf)
      return
    }
    case 'string': {
      const bytes = textEncoder.encode(value)
      writeTypeAndLength(parts, 3, bytes.length)
      parts.push(bytes)
      return
    }
    case 'object': {
      if (value instanceof Uint8Array) {
        writeTypeAndLength(parts, 2, value.length)
        parts.push(value)
        return
      }
      if (Array.isArray(value)) {
        writeTypeAndLength(parts, 4, value.length)
        for (const item of value) writeValue(parts, item, depth + 1)
        return
      }
      // Plain maps only. Keys with an undefined value are omitted, matching
      // what JSON.stringify does on the JSON side of this wire — an absent key
      // and an undefined one must read the same to the peer.
      const entries = Object.entries(value as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      )
      writeTypeAndLength(parts, 5, entries.length)
      for (const [key, item] of entries) {
        const bytes = textEncoder.encode(key)
        writeTypeAndLength(parts, 3, bytes.length)
        parts.push(bytes)
        writeValue(parts, item, depth + 1)
      }
      return
    }
    default:
      throw new TypeError(`cbor: cannot encode a ${typeof value}`)
  }
}

function writeByte(parts: Uint8Array[], byte: number): void {
  parts.push(Uint8Array.of(byte))
}

function writeTypeAndLength(parts: Uint8Array[], major: number, length: number): void {
  const base = major << 5
  if (length < 24) return writeByte(parts, base | length)
  if (length <= 0xff) {
    parts.push(Uint8Array.of(base | 24, length))
    return
  }
  if (length <= 0xffff) {
    parts.push(Uint8Array.of(base | 25, length >>> 8, length & 0xff))
    return
  }
  if (length <= 0xffffffff) {
    const buf = new Uint8Array(5)
    buf[0] = base | 26
    new DataView(buf.buffer).setUint32(1, length)
    parts.push(buf)
    return
  }
  const buf = new Uint8Array(9)
  buf[0] = base | 27
  const view = new DataView(buf.buffer)
  view.setUint32(1, Math.floor(length / 2 ** 32))
  view.setUint32(5, length >>> 0)
  parts.push(buf)
}

/** Decode a single CBOR item. Throws on anything outside the subset, on
 *  malformed input, and on trailing bytes after the item. */
export function decodeCbor(data: Uint8Array): unknown {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const state = {data, view, offset: 0}
  const value = readValue(state, 0)
  if (state.offset !== data.length) throw new Error('cbor: trailing bytes after the item')
  return value
}

interface DecodeState {
  data: Uint8Array
  view: DataView
  offset: number
}

function need(state: DecodeState, n: number): void {
  if (state.offset + n > state.data.length) throw new Error('cbor: truncated input')
}

function readLength(state: DecodeState, additional: number): number {
  if (additional < 24) return additional
  if (additional === 24) {
    need(state, 1)
    return state.view.getUint8(state.offset++)
  }
  if (additional === 25) {
    need(state, 2)
    const v = state.view.getUint16(state.offset)
    state.offset += 2
    return v
  }
  if (additional === 26) {
    need(state, 4)
    const v = state.view.getUint32(state.offset)
    state.offset += 4
    return v
  }
  if (additional === 27) {
    need(state, 8)
    const high = state.view.getUint32(state.offset)
    const low = state.view.getUint32(state.offset + 4)
    state.offset += 8
    const v = high * 2 ** 32 + low
    if (!Number.isSafeInteger(v)) throw new Error('cbor: integer out of range')
    return v
  }
  // 28-30 are reserved; 31 is an indefinite length, which nanocbor never emits.
  throw new Error('cbor: unsupported length encoding')
}

function readValue(state: DecodeState, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('cbor: structure too deep')
  need(state, 1)
  const byte = state.view.getUint8(state.offset++)
  const major = byte >> 5
  const additional = byte & 0x1f
  switch (major) {
    case 0:
      return readLength(state, additional)
    case 1:
      return -1 - readLength(state, additional)
    case 2: {
      const length = readLength(state, additional)
      need(state, length)
      const bytes = state.data.slice(state.offset, state.offset + length)
      state.offset += length
      return bytes
    }
    case 3: {
      const length = readLength(state, additional)
      need(state, length)
      const text = textDecoder.decode(state.data.subarray(state.offset, state.offset + length))
      state.offset += length
      return text
    }
    case 4: {
      const length = readLength(state, additional)
      const out: unknown[] = []
      for (let i = 0; i < length; i++) out.push(readValue(state, depth + 1))
      return out
    }
    case 5: {
      const length = readLength(state, additional)
      const out: Record<string, unknown> = {}
      for (let i = 0; i < length; i++) {
        const key = readValue(state, depth + 1)
        if (typeof key !== 'string') throw new Error('cbor: map keys must be strings')
        out[key] = readValue(state, depth + 1)
      }
      return out
    }
    case 7: {
      if (additional === 20) return false
      if (additional === 21) return true
      if (additional === 22) return null
      if (additional === 23) return undefined
      if (additional === 25) {
        need(state, 2)
        const v = readFloat16(state.view.getUint16(state.offset))
        state.offset += 2
        return v
      }
      if (additional === 26) {
        need(state, 4)
        const v = state.view.getFloat32(state.offset)
        state.offset += 4
        return v
      }
      if (additional === 27) {
        need(state, 8)
        const v = state.view.getFloat64(state.offset)
        state.offset += 8
        return v
      }
      throw new Error('cbor: unsupported simple value')
    }
    default:
      // major 6 (tags) included: nothing on this wire is tagged.
      throw new Error(`cbor: unsupported major type ${major}`)
  }
}

function readFloat16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const fraction = bits & 0x3ff
  if (exponent === 0) return sign * fraction * 2 ** -24
  if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN
  return sign * (1024 + fraction) * 2 ** (exponent - 25)
}
