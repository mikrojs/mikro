import type {BuildFeatures} from './build.js'
import {customFirmwareOf} from './bundledFirmware.js'
import type {ReadyEvent} from './session.js'

/** One-line summary of a build's firmware feature needs (e.g.
 * `features: wifi (imported), ble (from config)`), or undefined when there is
 * nothing to report. */
export function formatFeaturesLine(features: BuildFeatures): string | undefined {
  const parts = [
    ...features.imported.map((f) => `${f} (imported)`),
    ...features.floor.map((f) => `${f} (from config)`),
  ]
  return parts.length > 0 ? `features: ${parts.join(', ')}` : undefined
}

/** Compact features summary for agent/JSON result payloads, or undefined
 * (field omitted from the JSON) when the build needs nothing. */
export function agentFeatures(
  features: BuildFeatures | undefined,
): Pick<BuildFeatures, 'imported' | 'floor' | 'optional'> | undefined {
  if (features === undefined) return undefined
  const {imported, floor, optional} = features
  if (imported.length === 0 && floor.length === 0 && optional.length === 0) return undefined
  return {imported, floor, optional}
}

/** Error message when the connected device lacks a firmware feature the app
 * imports statically or its config's `features` floor declares; undefined
 * when the deploy may proceed. Legacy firmware reports no feature set and is
 * never gated; dynamic-only import()s never gate unless the floor names them. */
export function missingFeaturesError(
  features: BuildFeatures | undefined,
  ready: Pick<ReadyEvent, 'board' | 'chip' | 'features' | 'fw'>,
): string | undefined {
  if (features === undefined || ready.features === undefined) return undefined
  const device = new Set(ready.features)
  const missing = features.imported.filter((f) => !device.has(f))
  const missingFloor = features.floor.filter((f) => !device.has(f))
  if (missing.length === 0 && missingFloor.length === 0) return undefined
  // Surplus device features (device ⊃ required ∪ floor) draw no warning:
  // full firmware is the default (slimming is opt-out), so surplus is the
  // normal case. Surfacing it is a future `mikro doctor` concern.
  const reasons = [
    ...missing.map((feature) => {
      const mods = (features.modules[feature] ?? []).map((m) => `mikro/${m}`).join(', ')
      return `  - ${feature}: imported as ${mods}`
    }),
    ...missingFloor.map((feature) => `  - ${feature}: listed under features in mikro.config.ts`),
  ]
  const all = [...missing, ...missingFloor]
  const named =
    all.length === 1 ? all[0]! : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]!}`
  const firmware = ready.board ?? ready.chip ?? 'unknown'
  // Stock firmware has every feature, so a gap usually means a custom build:
  // `mikro flash` would replace that build, and is the wrong advice for it.
  const custom = customFirmwareOf(ready)
  const fix =
    custom === undefined
      ? [
          `The device currently runs the ${firmware} firmware.`,
          // Plain `mikro flash` installs the bundled <chip>-generic build,
          // which has every feature the chip supports.
          `To deploy this app, flash the generic ${ready.chip ?? 'chip'} firmware, ` +
            `which includes ${named}:`,
          '',
          '  mikro flash',
        ]
      : [
          `The device currently runs custom firmware "${custom}".`,
          `To deploy this app, rebuild that firmware with ${named}, then flash it:`,
          '',
          '  mikro flash --build-dir <your-firmware-build>',
        ]
  return [
    all.length > 1
      ? "This app needs firmware features that the connected device's current firmware does not support:"
      : "This app needs a firmware feature that the connected device's current firmware does not support:",
    '',
    ...reasons,
    '',
    ...fix,
  ].join('\n')
}
