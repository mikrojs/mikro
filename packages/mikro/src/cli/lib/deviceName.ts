import {getCachedDeviceId, getCachedName, getCachedNameByDeviceId} from './deviceCache.js'
import {deviceIdFromSerial} from './deviceId.js'
import {suggestDeviceName} from './suggestName.js'

/**
 * A device's name. The device owns it: `mikro name set` writes the mik.sys
 * `name` key over the wire, and the connect handshake reports it back, cached
 * per serial in device-cache.json so `ls` and `--port` work while disconnected.
 * A device with no name shows its device id. That is deliberate and there is no
 * prompt or hint nudging you to name it: naming writes to the device, and the
 * commands that connect (`deploy`, `dev`, `console`, `test`) run in a hot loop
 * where a nag would be noise. `mikro name set` with no argument is the one-step
 * answer when you want one.
 */

/**
 * mik.sys key holding the device's name together with the logical revision that
 * arbitrates renames against the registry, as the `[rev, name]` pair the
 * check-in carries — stored as JSON text because CMD_KV_SET has no type tag, so
 * adopting a registry name is a straight re-encode with no transcoding between
 * wire and storage. One key, so the pair is written atomically: a torn write
 * can't strand a name at the wrong revision and let a stale name win a later
 * sync. A cleared name keeps its revision (`[rev]`, second element absent) so
 * the deletion propagates instead of the old name resurrecting.
 */
export const NAME_KV = 'name'

export interface DeviceNameState {
  rev: number
  /** Absent when no name is set — callers derive one from the device id. */
  name?: string | undefined
  /** The key held bytes that could not be read as a `[rev, name]` pair.
   *
   *  Distinct from "never named", which is the same `rev: 0, name: undefined`
   *  shape. The device's real revision is unknown here, not zero, so anything
   *  that would write identity off that assumption has to decline instead: a
   *  re-seed at rev 1 overwrites whatever name is really stored, and loses to
   *  any registry holding a higher revision. */
  corrupt?: boolean
}

export function encodeDeviceName(state: DeviceNameState): string {
  return JSON.stringify(state.name === undefined ? [state.rev] : [state.rev, state.name])
}

/** Missing means "never named": revision 0, no name. Present but unparseable
 *  reports `corrupt` alongside, because the two are not the same fact and
 *  callers that write identity must not treat the second as the first. */
export function decodeDeviceName(raw: string | undefined): DeviceNameState {
  const unnamed: DeviceNameState = {rev: 0, name: undefined}
  const corrupt: DeviceNameState = {rev: 0, name: undefined, corrupt: true}
  if (raw === undefined) return unnamed
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return corrupt
  }
  if (!Array.isArray(parsed)) return corrupt
  const [rev, name] = parsed as [unknown, unknown]
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) return corrupt
  return {rev, name: typeof name === 'string' && name !== '' ? name : undefined}
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const NAME_MAX = 64

export type NameCheck = {ok: true} | {ok: false; error: string}

/** Checked before writing to the device: names reach terminals, completions and
 *  `--port`, so control/ANSI characters must never get in. */
export function validateDeviceName(name: string): NameCheck {
  if (!name) return {ok: false, error: 'Name must not be empty'}
  if (name.length > NAME_MAX) {
    return {ok: false, error: `Name must be ${NAME_MAX} characters or fewer`}
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error:
        'Name must start with a letter or digit and use only letters, digits, dot, dash, or underscore',
    }
  }
  return {ok: true}
}

/**
 * A suggested name derived from the device id, used **only to seed a real name
 * at provisioning** (`mikro ota enroll`), never for display. Once minted it is
 * stored, so changing this derivation later only affects devices provisioned
 * afterwards — it can never rename an existing device. Displaying it instead
 * would reintroduce exactly that: a device's apparent name would be a function
 * of the CLI version, and would change under it on upgrade.
 *
 * Undefined only when there's nothing to seed from. Pass the firmware-reported
 * deviceId to resolve bridge boards whose serial isn't the chip MAC.
 */
export function deviceGeneratedName(
  serialNumber: string | undefined,
  deviceId?: string | null,
): string | undefined {
  const seed =
    deviceIdFromSerial(serialNumber) ?? getCachedDeviceId(serialNumber) ?? deviceId ?? serialNumber
  return seed ? suggestDeviceName(seed) : undefined
}

/**
 * What to show for a board: the name it reported for itself, else its device
 * id, else "(unknown)". Only real, stored values — never a derived name, so
 * what you see always has a referent on the device and is stable across CLI
 * upgrades (see deviceGeneratedName).
 */
export function deviceDisplayName(
  serialNumber: string | undefined,
  deviceId?: string | null,
): string {
  return (
    getCachedName(serialNumber) ??
    getCachedNameByDeviceId(deviceId) ??
    deviceIdFromSerial(serialNumber) ??
    getCachedDeviceId(serialNumber) ??
    deviceId ??
    serialNumber ??
    '(unknown)'
  )
}

/** Resolve a `--port` token, in order: exact path, displayed name, raw serial,
 *  then derived/cached device id. Undefined if nothing matches. */
export function matchPortToken<T extends {path: string; serialNumber?: string | undefined}>(
  devices: T[],
  token: string,
): T | undefined {
  const byPath = devices.find((d) => d.path === token)
  if (byPath) return byPath

  // Match whatever is displayed, so a board always resolves by the name you can
  // see. That is its set name, else its device id — never a derived name, which
  // would otherwise stop resolving the moment the derivation changed.
  const byName = devices.find((d) => deviceDisplayName(d.serialNumber) === token)
  if (byName) return byName

  const bySerial = devices.find((d) => d.serialNumber === token)
  if (bySerial) return bySerial

  return devices.find(
    (d) =>
      deviceIdFromSerial(d.serialNumber) === token || getCachedDeviceId(d.serialNumber) === token,
  )
}
