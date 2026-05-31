/**
 * Host-side reconstruction of the firmware device id (get_device_id() in
 * platform_esp32.cpp): the ESP32 base MAC as 10 chars of Crockford's Base32.
 * For native-USB devices the USB serialNumber is that MAC, so we derive the
 * same id without opening the port. Must stay byte-identical to the firmware.
 */

const CB32 = '0123456789abcdefghjkmnpqrstvwxyz'

/** 10-char id from a USB serial that is a 6-octet MAC, else undefined (e.g. a
 *  USB-UART bridge whose serial is the bridge's, not the chip's). */
export function deviceIdFromSerial(serial: string | undefined): string | undefined {
  const bytes = parseMac(serial)
  if (!bytes) return undefined

  // 48 bits fits a JS safe integer, so plain arithmetic avoids BigInt (absent
  // in the mikrojs runtime) and 32-bit shifts. Pack MSB-first, emit MSB-first.
  let v = 0
  for (const b of bytes) v = v * 256 + b

  let id = ''
  for (let i = 0; i < 10; i++) {
    id = CB32[v % 32] + id
    v = Math.floor(v / 32)
  }
  return id
}

function parseMac(serial: string | undefined): number[] | undefined {
  if (!serial) return undefined
  // Accept "54:32:04:22:7B:D4", "54-32-...", or bare "543204227BD4".
  const hex = serial.replace(/[:-]/g, '')
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return undefined
  const bytes: number[] = []
  for (let i = 0; i < 12; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  return bytes
}
