// BLE UUID parsing. Pure helper, no native dependency.
//
// BLE has two practical UUID sizes:
//   - 16-bit: SIG-assigned UUIDs like 0x180F (Battery Service). Written as
//     4 hex characters: "180f".
//   - 128-bit: vendor-custom UUIDs. Written in canonical dashed form:
//     "6e400001-b5a3-f393-e0a9-e50e24dcca9e".
//
// 32-bit UUIDs exist in the spec but are nearly never used in practice; we
// don't accept them here. Users who need one can write the full 128-bit form.

/** Parsed 16-bit UUID. */
export interface ParsedUuid16 {
  readonly kind: 16
  /** The 16-bit value, 0..0xFFFF. */
  readonly value: number
  /** Normalized lowercase form, e.g. "180f". */
  readonly normalized: string
}

/** Parsed 128-bit UUID. */
export interface ParsedUuid128 {
  readonly kind: 128
  /**
   * 16 bytes in network / big-endian order — the same order you'd read off
   * a formatted UUID string like "0000180f-0000-1000-8000-00805f9b34fb".
   * Native code is responsible for converting to NimBLE's internal
   * little-endian representation when building `ble_uuid128_t`.
   */
  readonly bytes: Uint8Array
  /** Normalized lowercase form, e.g. "6e400001-b5a3-f393-e0a9-e50e24dcca9e". */
  readonly normalized: string
}

export type ParsedUuid = ParsedUuid16 | ParsedUuid128

const HEX_16 = /^[0-9a-fA-F]{4}$/
const HEX_128 = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Parses a BLE UUID string into a structured form. Accepts:
 *   - 4-char shorthand for 16-bit UUIDs: `"180f"`, `"180F"`
 *   - Full 128-bit form with dashes: `"6e400001-b5a3-f393-e0a9-e50e24dcca9e"`
 *
 * Leading/trailing whitespace is not accepted. Returns `null` for invalid
 * input so the caller can wrap the original value in an `InvalidUuid` error.
 */
export function parseUuid(input: unknown): ParsedUuid | null {
  if (typeof input !== 'string') return null

  if (HEX_16.test(input)) {
    return {
      kind: 16,
      value: Number.parseInt(input, 16),
      normalized: input.toLowerCase(),
    }
  }

  if (HEX_128.test(input)) {
    const normalized = input.toLowerCase()
    const hexOnly = normalized.replace(/-/g, '')
    const bytes = new Uint8Array(16)
    for (let i = 0; i < 16; i++) {
      bytes[i] = Number.parseInt(hexOnly.substring(i * 2, i * 2 + 2), 16)
    }
    return {kind: 128, bytes, normalized}
  }

  return null
}

/**
 * Compares two parsed UUIDs for equality. Two 16-bit UUIDs are equal iff
 * their values match; two 128-bit UUIDs are equal iff all 16 bytes match.
 * A 16-bit and a 128-bit UUID are never equal here — callers that want to
 * compare a 16-bit shorthand against its canonical 128-bit expansion should
 * normalize to one form first.
 */
export function uuidsEqual(a: ParsedUuid, b: ParsedUuid): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 16) return a.value === (b as ParsedUuid16).value
  const ab = a.bytes
  const bb = (b as ParsedUuid128).bytes
  if (ab.length !== bb.length) return false
  for (let i = 0; i < ab.length; i++) {
    if (ab[i] !== bb[i]) return false
  }
  return true
}
