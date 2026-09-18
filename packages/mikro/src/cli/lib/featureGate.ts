import type {BuildFeatures} from './build.js'
import {customFirmwareOf} from './bundledFirmware.js'
import type {ReadyEvent} from './session.js'

/** One-line summary of a build's firmware feature needs (e.g.
 * `features: wifi (imported), ble (floor)`), or undefined when there is
 * nothing to report. */
export function formatFeaturesLine(features: BuildFeatures): string | undefined {
  const parts = [
    ...features.imported.map((f) => `${f} (imported)`),
    ...features.floor.map((f) => `${f} (floor)`),
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

/** Error message when the app statically imports modules whose firmware
 * features the connected device lacks; undefined when the deploy may proceed.
 * Legacy firmware reports no feature set and is never gated; dynamic-only
 * import()s never gate either. */
export function missingFeaturesError(
  features: BuildFeatures | undefined,
  ready: Pick<ReadyEvent, 'board' | 'chip' | 'features' | 'fw'>,
): string | undefined {
  if (features === undefined || ready.features === undefined) return undefined
  const device = new Set(ready.features)
  const missing = features.imported.filter((f) => !device.has(f))
  if (missing.length === 0) return undefined
  // Surplus device features (device ⊃ required ∪ floor) draw no warning:
  // full firmware is the default (slimming is opt-out), so surplus is the
  // normal case. Surfacing it is a future `mikro doctor` concern.
  const firmware = ready.board ?? ready.chip ?? 'unknown'
  const lines = missing.map((feature) => {
    const mods = features.modules[feature] ?? []
    const verb = mods.length === 1 ? 'needs' : 'need'
    return (
      `This app imports ${mods.map((m) => `mikro/${m}`).join(', ')} which ${verb} the ` +
      `'${feature}' firmware feature, but the connected device's firmware (${firmware}) ` +
      `does not include it.`
    )
  })
  // Stock firmware has every feature, so a gap usually means a custom build:
  // `mikro flash` would replace that build, and is the wrong advice for it.
  const custom = customFirmwareOf(ready)
  const fix =
    custom === undefined
      ? 'Reflash with: mikro flash'
      : `The device runs custom firmware ("${custom}"). Rebuild it with the feature enabled, ` +
        'then flash it: mikro flash --build-dir <your-firmware-build>'
  return [...lines, fix].join('\n')
}
