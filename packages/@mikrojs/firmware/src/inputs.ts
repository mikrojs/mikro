/**
 * Resolve a firmware project's native modules to build inputs.
 *
 * Nothing is inferred from what is installed: the project's CMakeLists.txt
 * lists the native modules to compile in (MIKROJS_NATIVE_MODULES), by the
 * import specifier apps use. Each resolves to a package export whose `native`
 * condition points at C/C++ source, or, for a `#` specifier, to such an entry
 * in the `imports` field of the app that contains the project. The source's
 * directory is added as an ESP-IDF component.
 *
 * The files read on the way are returned too, so CMake re-runs this when one
 * of them changes.
 *
 * Run by resolve.cmake (through project.cmake) via `mikro-fw inputs <dir> --native-modules=…`.
 */
import {existsSync, readFileSync} from 'node:fs'
import {basename, join, resolve} from 'node:path'

import {
  findImportsPackage,
  findPackageDir,
  ManifestError,
  type NativeModule,
  type PackageJson,
  packageNameOf,
  resolveNativeModule,
} from './manifest.ts'

/** Semicolon-separated CMake lists; empty strings where nothing applies. */
export interface FirmwareInputs {
  components: string
  /** Import specifiers of the native modules compiled in. */
  nativeModules: string
  sdkconfigs: string
  /** Files read while resolving, for CMAKE_CONFIGURE_DEPENDS. */
  configureDepends: string
}

/** Components every firmware already has (see project.cmake). */
const RESERVED_COMPONENTS = ['main', 'mikrojs']

/** sdkconfig defaults of the MIKROJS_BOARD board from `mikrojs.boards` in the
 *  project's dependencies. */
function boardSdkconfigs(projectDir: string): string[] {
  const packageJson = join(projectDir, 'package.json')
  if (!existsSync(packageJson)) return []
  const project = JSON.parse(readFileSync(packageJson, 'utf8')) as PackageJson
  const board = process.env.MIKROJS_BOARD ?? ''
  const sdkconfigs: string[] = []
  for (const dep of Object.keys(project.dependencies ?? {})) {
    const depDir = findPackageDir(dep, projectDir)
    if (!depDir) continue
    const file = join(depDir, 'package.json')
    let depPkg: PackageJson
    try {
      depPkg = JSON.parse(readFileSync(file, 'utf8')) as PackageJson
    } catch (e) {
      throw new ManifestError(`cannot read ${file}: ${(e as Error).message}`, {cause: e})
    }
    for (const [subpath, config] of Object.entries(depPkg.mikrojs?.boards ?? {})) {
      const boardName = subpath.startsWith('./') ? subpath.slice(2) : subpath
      if ((!board || board === boardName) && config.sdkconfig) {
        sdkconfigs.push(resolve(depDir, config.sdkconfig))
      }
    }
  }
  return sdkconfigs
}

/** A package's native module, which must be installed where the project can import it. */
function packageNativeModule(
  specifier: string,
  projectDir: string,
  configureDepends: Set<string>,
): NativeModule {
  const pkg = packageNameOf(specifier)
  const packageDir = findPackageDir(pkg, projectDir)
  if (!packageDir) {
    throw new ManifestError(
      `MIKROJS_NATIVE_MODULES names "${specifier}", but no package "${pkg}" is ` +
        `installed (searched from ${projectDir})`,
    )
  }
  configureDepends.add(join(packageDir, 'package.json'))
  const nativeModule = resolveNativeModule(specifier, projectDir)
  if (!nativeModule) {
    throw new ManifestError(
      `MIKROJS_NATIVE_MODULES names "${specifier}", which is not a native module: ` +
        `${pkg} has no export for it whose "native" condition points at C/C++ source`,
    )
  }
  return nativeModule
}

/**
 * An app's own native module, a `#` import: the entry for it in the `imports`
 * field of the nearest package at or above the project that has one. That is
 * the app when the project is the app, or a folder in it.
 */
function appNativeModule(
  specifier: string,
  projectDir: string,
  configureDepends: Set<string>,
): NativeModule {
  const appDir = findImportsPackage(specifier, projectDir)
  if (!appDir) {
    throw new ManifestError(
      `MIKROJS_NATIVE_MODULES names "${specifier}", but no package.json at or above ` +
        `${projectDir} has an "imports" entry for it`,
    )
  }
  const packageJson = join(appDir, 'package.json')
  configureDepends.add(packageJson)
  const nativeModule = resolveNativeModule(specifier, appDir)
  if (!nativeModule) {
    throw new ManifestError(
      `MIKROJS_NATIVE_MODULES names "${specifier}", which is not a native module: ` +
        `its "imports" entry in ${packageJson} has no "native" condition that points at ` +
        'C/C++ source',
    )
  }
  return nativeModule
}

/**
 * @param projectDir - Directory containing the firmware project
 * @param declared - MIKROJS_NATIVE_MODULES
 */
export async function resolveFirmwareInputs(
  projectDir: string,
  {nativeModules: declared = []}: {nativeModules?: string[]} = {},
): Promise<FirmwareInputs> {
  /** Files whose change can change the result. */
  const configureDepends = new Set([join(projectDir, 'package.json')])
  const components: {label: string; dir: string}[] = []
  const specifiers = new Set<string>()

  for (const specifier of declared) {
    const nativeModule = specifier.startsWith('#')
      ? appNativeModule(specifier, projectDir, configureDepends)
      : packageNativeModule(specifier, projectDir, configureDepends)
    specifiers.add(specifier)
    const name = basename(nativeModule.dir)
    // Two exports whose sources share a directory are one component.
    if (components.some((c) => c.dir === nativeModule.dir)) continue
    // ESP-IDF names a component after its directory and silently skips a
    // second one with the same name, so a clash has to fail here.
    if (RESERVED_COMPONENTS.includes(name)) {
      throw new ManifestError(
        `native module ${nativeModule.label} has a component named "${name}" ` +
          `(${nativeModule.dir}); the firmware has its own component of that name, so ` +
          'rename the directory',
      )
    }
    const clash = components.find((c) => basename(c.dir) === name)
    if (clash) {
      throw new ManifestError(
        `native modules ${clash.label} and ${nativeModule.label} both have a component named "${name}" ` +
          `(${clash.dir}, ${nativeModule.dir}); ESP-IDF names components after their ` +
          'directory, so the names must differ',
      )
    }
    components.push({label: nativeModule.label, dir: nativeModule.dir})
  }

  return {
    components: components.map((c) => c.dir).join(';'),
    nativeModules: [...specifiers].sort().join(';'),
    sdkconfigs: boardSdkconfigs(projectDir).join(';'),
    configureDepends: [...configureDepends].filter((file) => existsSync(file)).join(';'),
  }
}
