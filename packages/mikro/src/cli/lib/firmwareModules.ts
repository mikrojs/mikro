import {
  findPackageDir,
  ManifestError,
  packageNameOf,
  resolveNativeModule,
} from '@mikrojs/firmware/manifest'

import {UserError} from './errorMessage.js'

const nativeModuleCache = new Map<string, string | undefined>()

/**
 * The label (`<package>/<dir>`) of the native module a bare import names, or
 * undefined. A native module is a package export whose target is C/C++ source:
 * the firmware provides it, so the import stays external, nothing of it is
 * deployed, and a deploy is refused when the device's firmware lacks it.
 */
export function nativeModuleLabel(specifier: string, fromDir: string): string | undefined {
  const key = `${fromDir}\0${specifier}`
  if (nativeModuleCache.has(key)) return nativeModuleCache.get(key)
  let label: string | undefined
  try {
    label = resolveNativeModule(specifier, fromDir)?.label
  } catch (error) {
    // A package that cannot be read stops the build with a message, not a stack.
    const detail = error instanceof Error ? error.message : String(error)
    throw new UserError(
      error instanceof ManifestError
        ? detail
        : `Cannot read the package "${packageNameOf(specifier)}" imports as "${specifier}": ${detail}`,
      {cause: error},
    )
  }
  // Not cached while the package is missing: `mikro dev` may see it installed.
  if (label !== undefined || findPackageDir(packageNameOf(specifier), fromDir) !== undefined) {
    nativeModuleCache.set(key, label)
  }
  return label
}
