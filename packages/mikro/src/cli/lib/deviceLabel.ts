import {getCachedChip, getCachedDeviceId} from './deviceCache.js'
import {deviceIdFromSerial} from './deviceId.js'
import {deviceDisplayName} from './deviceName.js'

/**
 * One canonical way to render a device wherever it's listed, so the picker, an
 * `ls`, and a `deploy`/`flash` error all call the same board by the same
 * identity: its name and a stable device id (not the raw USB serial).
 */

type DeviceLike = {path: string; serialNumber?: string | undefined}

/**
 * The parenthetical shown after the name/path, as labeled fields, e.g.
 * "(chip=esp32c6, id=2m68224yym)". The chip (only known after a connect) is
 * omitted until then; the id is derived from the serial (native USB), else
 * cached from a prior connect (bridge boards), else the raw serial. The whole
 * group is dropped if there's nothing to show.
 */
function deviceMeta(serialNumber: string | undefined, displayName: string): string {
  const chip = getCachedChip(serialNumber)
  const id = deviceIdFromSerial(serialNumber) ?? getCachedDeviceId(serialNumber) ?? serialNumber
  const parts: string[] = []
  if (chip) parts.push(`chip=${chip}`)
  // An unnamed device is displayed *as* its id, so repeating it here would
  // render "2m68224yym (id=2m68224yym)".
  if (id && id !== displayName) parts.push(`id=${id}`)
  return parts.length ? `(${parts.join(', ')})` : ''
}

/** Inline label for sentences/badges, e.g. "swift-cheetah (chip=esp32c6, id=0r8m4h2qyk)". */
export function deviceLabel(device: DeviceLike): string {
  const name = deviceDisplayName(device.serialNumber)
  const meta = deviceMeta(device.serialNumber, name)
  return meta ? `${name} ${meta}` : name
}

/** Column-aligned listing lines: "name  path  (chip=…, id=…)". */
export function formatDeviceList(devices: readonly DeviceLike[]): string[] {
  const rows = devices.map((d) => {
    const name = deviceDisplayName(d.serialNumber)
    return {name, path: d.path, meta: deviceMeta(d.serialNumber, name)}
  })
  const wName = Math.max(0, ...rows.map((r) => r.name.length))
  const wPath = Math.max(0, ...rows.map((r) => r.path.length))
  return rows.map((r) => `${r.name.padEnd(wName)}  ${r.path.padEnd(wPath)}  ${r.meta}`.trimEnd())
}
