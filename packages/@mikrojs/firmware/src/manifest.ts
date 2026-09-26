/**
 * Resolver of native modules from package manifests (package.json).
 *
 * A native module (C/C++ the firmware must carry: a driver, or any other
 * native code) has no manifest of its own. It is a package export whose
 * `native` condition targets a C/C++ source file, with a `types` condition for
 * TypeScript and, optionally, a `default` that host tools (tests, the
 * simulator) load instead:
 *   "./sh8601": {"types": "./sh8601/sh8601.d.ts", "native": "./sh8601/sh8601.cpp"}
 * An app can also keep a native module of its own, private to it, as an entry
 * of its `imports` field (a `#` specifier), in the same form:
 *   "#sensor": {"types": "./native/sensor/sensor.d.ts", "native": "./native/sensor/sensor.cpp"}
 * The source file's directory is the ESP-IDF component (see inputs.ts).
 */
import {existsSync, readFileSync} from 'node:fs'
import {basename, dirname, join, relative, resolve} from 'node:path'

export class ManifestError extends Error {
  override name = 'ManifestError'
}

export interface NativeModule {
  /** The source's directory name, which ESP-IDF names the component after. */
  name: string
  /** `<package>[/<dir in package>]`, for messages. */
  label: string
  /** The C/C++ export target, and its directory: the ESP-IDF component. */
  file: string
  dir: string
}

/** The fields of a package.json that the resolver reads. */
export interface PackageJson {
  name?: string
  exports?: unknown
  imports?: unknown
  dependencies?: Record<string, string>
  mikrojs?: {boards?: Record<string, {sdkconfig?: string}>}
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ManifestError(message)
}

/** The package an import specifier names: `@scope/name` or `name`. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

/** Directory of an installed package, walking node_modules up from fromDir. */
export function findPackageDir(name: string, fromDir: string): string | undefined {
  let dir = resolve(fromDir)
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Root of the package that `fromDir` is in (nearest package.json upwards). */
export function findPackageRoot(fromDir: string): string | undefined {
  let dir = resolve(fromDir)
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson
}

/** The entry for `key` in an `exports` or `imports` map, or undefined. */
function mapEntry(map: unknown, key: string): unknown {
  return typeof map === 'object' && map !== null && Object.hasOwn(map, key)
    ? (map as Record<string, unknown>)[key]
    : undefined
}

/** The C/C++ source an export's `native` condition targets, or undefined. */
function nativeTarget(value: unknown): string | undefined {
  const target = mapEntry(value, 'native')
  return typeof target === 'string' ? target : undefined
}

const NATIVE_SOURCE_RE = /\.(c|cc|cpp|cxx)$/

/** Whether `file` is C/C++ source: the target of a native module's export. */
export function isNativeSource(file: string): boolean {
  return NATIVE_SOURCE_RE.test(file)
}

/**
 * The native module whose export target is the C/C++ source `file`: its
 * directory is the ESP-IDF component, labelled `<package>[/<dir in package>]`.
 */
export function nativeModuleOf(file: string): NativeModule {
  const dir = dirname(file)
  const packageDir = findPackageRoot(dir)
  check(packageDir, `native module ${file}: no package.json above it`)
  const packageName = readPackageJson(packageDir).name
  const inPackage = relative(packageDir, dir)
  const label = inPackage ? `${packageName}/${inPackage}` : `${packageName}`
  check(
    existsSync(join(dir, 'CMakeLists.txt')),
    `native module ${label}: ${dir} has no CMakeLists.txt; the directory of ${basename(file)} must be an ESP-IDF component`,
  )
  return {name: basename(dir), label, file, dir}
}

/**
 * The entry of an `imports` field for a `#` specifier, by Node's rules: the
 * exact key, or else the pattern key (one `*`) with the longest prefix. For a
 * pattern, `match` is the part of the specifier that `*` stands for.
 */
function importsEntry(
  imports: unknown,
  specifier: string,
): {value: unknown; match?: string} | undefined {
  if (typeof imports !== 'object' || imports === null) return undefined
  if (Object.hasOwn(imports, specifier) && !specifier.includes('*')) {
    return {value: mapEntry(imports, specifier)}
  }
  const patterns = Object.keys(imports)
    .filter((key) => key.split('*').length === 2)
    .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length)
  for (const pattern of patterns) {
    const [base = '', trailer = ''] = pattern.split('*')
    if (specifier.length < pattern.length) continue
    if (!specifier.startsWith(base) || !specifier.endsWith(trailer)) continue
    const match = specifier.slice(base.length, specifier.length - trailer.length)
    // Node refuses a match that leaves the package, and so does this.
    if (match.split('/').some((segment) => segment === '.' || segment === '..')) return undefined
    return {value: mapEntry(imports, pattern), match}
  }
  return undefined
}

/**
 * The nearest package at or above `fromDir` whose `imports` field has an entry
 * for the `#` specifier, or undefined.
 */
export function findImportsPackage(specifier: string, fromDir: string): string | undefined {
  let dir = findPackageRoot(fromDir)
  while (dir !== undefined) {
    if (importsEntry(readPackageJson(dir).imports, specifier)) return dir
    const parent = dirname(dir)
    dir = parent === dir ? undefined : findPackageRoot(parent)
  }
  return undefined
}

/**
 * The native module a bare or `#` import specifier names, resolved from
 * `fromDir`: the package's export for that subpath, or the importing package's
 * `imports` entry, targets C/C++ source. Undefined for anything else (JS
 * modules, packages that are not installed).
 */
export function resolveNativeModule(specifier: string, fromDir: string): NativeModule | undefined {
  if (specifier.startsWith('#')) {
    const packageDir = findPackageRoot(fromDir)
    if (!packageDir) return undefined
    const entry = importsEntry(readPackageJson(packageDir).imports, specifier)
    const target = nativeTarget(entry?.value)
    if (entry === undefined || target === undefined) return undefined
    const file = entry.match === undefined ? target : target.replaceAll('*', entry.match)
    return isNativeSource(file) ? nativeModuleOf(join(packageDir, file)) : undefined
  }
  if (!/^(@[^/]+\/)?[^./@][^/]*(\/|$)/.test(specifier)) return undefined
  const packageName = packageNameOf(specifier)
  // A package may import itself by name (Node's self-reference).
  const ownDir = findPackageRoot(fromDir)
  const packageDir =
    ownDir && readPackageJson(ownDir).name === packageName
      ? ownDir
      : findPackageDir(packageName, fromDir)
  if (!packageDir) return undefined
  const subpath = specifier.slice(packageName.length + 1)
  const exports = readPackageJson(packageDir).exports
  const target = nativeTarget(mapEntry(exports, subpath ? `./${subpath}` : '.'))
  if (target === undefined || !isNativeSource(target)) return undefined
  return nativeModuleOf(join(packageDir, target))
}
