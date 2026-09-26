import type {BuildFeatures, NativeNeeds} from './build.js'
import {customFirmwareOf} from './bundledFirmware.js'
import type {ReadyEvent} from './session.js'

/** One-line summary of a build's firmware needs (e.g.
 * `features: wifi (imported), ble (from config), @mikrojs/drivers/sh8601 (imported)`),
 * or undefined when there is nothing to report. */
export function formatFeaturesLine(features: BuildFeatures): string | undefined {
  const parts = [
    ...features.imported.map((f) => `${f} (imported)`),
    ...features.floor.map((f) => `${f} (from config)`),
    ...features.natives.imported.map((id) => `${id} (imported)`),
  ]
  return parts.length > 0 ? `features: ${parts.join(', ')}` : undefined
}

/** Compact features summary for agent/JSON result payloads, or undefined
 * (field omitted from the JSON) when the build needs nothing. */
export function agentFeatures(
  features: BuildFeatures | undefined,
): (Pick<BuildFeatures, 'imported' | 'floor' | 'optional'> & {natives?: NativeNeeds}) | undefined {
  if (features === undefined) return undefined
  const {imported, floor, optional, natives} = features
  const hasNatives = natives.imported.length > 0 || natives.optional.length > 0
  if (imported.length === 0 && floor.length === 0 && optional.length === 0 && !hasNatives) {
    return undefined
  }
  return hasNatives ? {imported, floor, optional, natives} : {imported, floor, optional}
}

/** Error message when the connected device's firmware lacks something the app
 * needs: a feature that a statically imported builtin requires or that the
 * config's `features` floor declares, or a package native module the firmware
 * was not built with. Undefined when the deploy may proceed. Legacy firmware
 * reports neither list and is never gated; dynamic-only import()s never gate
 * unless the floor names their feature. */
export function missingFeaturesError(
  features: BuildFeatures | undefined,
  ready: Pick<ReadyEvent, 'board' | 'chip' | 'features' | 'fw' | 'natives'>,
): string | undefined {
  if (features === undefined) return undefined
  const firmware = ready.board ?? ready.chip ?? 'unknown'
  const sections: string[] = []
  const device = new Set(ready.features ?? [])
  const missing =
    ready.features === undefined ? [] : features.imported.filter((f) => !device.has(f))
  const missingFloor =
    ready.features === undefined ? [] : features.floor.filter((f) => !device.has(f))
  if (missing.length > 0 || missingFloor.length > 0) {
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
    sections.push(
      [
        all.length > 1
          ? "This app needs firmware features that the connected device's current firmware does not support:"
          : "This app needs a firmware feature that the connected device's current firmware does not support:",
        '',
        ...reasons,
        '',
        ...fix,
      ].join('\n'),
    )
  }
  if (ready.natives !== undefined) {
    const built = new Set(ready.natives)
    const absent = features.natives.imported.filter((id) => !built.has(id))
    if (absent.length > 0) {
      const one = absent.length === 1
      const it = one ? 'it' : 'them'
      sections.push(
        [
          `This app imports ${one ? 'a native module' : `${absent.length} native modules`} that ` +
            `the device's firmware (${firmware}) was not built with:`,
          // The owner is `<package>/<dir>`: worth showing only when it is not the specifier.
          ...absent.map((id) => {
            const owner = features.natives.owners[id]
            return owner === undefined || owner === id ? `  ${id}` : `  ${id} (${owner})`
          }),
          // Not plain `mikro flash`: that installs the generic firmware.
          `List ${it} in your firmware project's MIKROJS_NATIVE_MODULES, build the firmware, ` +
            'and flash that build:',
          '  mikro flash --build-dir <your-firmware-build>',
          // Stock firmware: the user may have no firmware project yet.
          ...(customFirmwareOf(ready) === undefined
            ? ['To create a firmware project, see https://mikrojs.dev/develop/custom-firmware']
            : []),
        ].join('\n'),
      )
    }
  }
  return sections.length > 0 ? sections.join('\n\n') : undefined
}
