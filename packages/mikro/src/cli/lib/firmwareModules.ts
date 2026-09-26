import * as pathlib from 'node:path'

import {
  findPackageDir,
  findPackageRoot,
  ManifestError,
  packageNameOf,
  resolveNativeModule,
} from '@mikrojs/firmware/manifest'

import {UserError} from './errorMessage.js'
import {resolveProjectRoot} from './projectRoot.js'

const nativeModuleCache = new Map<string, string | undefined>()

/**
 * The label (`<package>/<dir>`) of the native module a bare or `#` import
 * names, or undefined. A native module is a package export, or an entry of the
 * app's own `imports` field, whose target is C/C++ source: the firmware
 * provides it, so the import stays external, nothing of it is deployed, and a
 * deploy is refused when the device's firmware lacks it.
 */
export function nativeModuleLabel(specifier: string, fromDir: string): string | undefined {
  const key = `${fromDir}\0${specifier}`
  if (nativeModuleCache.has(key)) return nativeModuleCache.get(key)
  const isImport = specifier.startsWith('#')
  let label: string | undefined
  try {
    label = resolveNativeModule(specifier, fromDir)?.label
  } catch (error) {
    // A package that cannot be read stops the build with a message, not a stack.
    const detail = error instanceof Error ? error.message : String(error)
    throw new UserError(
      error instanceof ManifestError
        ? detail
        : isImport
          ? `Cannot read the package.json that resolves "${specifier}": ${detail}`
          : `Cannot read the package "${packageNameOf(specifier)}" imports as "${specifier}": ${detail}`,
      {cause: error},
    )
  }
  if (isImport && label !== undefined) {
    // The firmware registers a # name once, for the app. A package's own #
    // name could clash with the app's, so a package exports its native modules.
    const importer = findPackageRoot(fromDir)
    if (importer !== resolveProjectRoot()) {
      throw new UserError(
        `Cannot import "${specifier}" in ${pathlib.join(importer ?? fromDir, 'package.json')}: ` +
          'only the app can map a # import to a native module. A package exports its ' +
          'native modules instead.',
      )
    }
  }
  // Not cached while the package is missing: `mikro dev` may see it installed.
  if (
    label !== undefined ||
    isImport ||
    findPackageDir(packageNameOf(specifier), fromDir) !== undefined
  ) {
    nativeModuleCache.set(key, label)
  }
  return label
}
