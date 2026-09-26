export class ManifestError extends Error {}

export interface NativeModule {
  /** The source's directory name, which ESP-IDF names the component after. */
  name: string
  /** `<package>[/<dir in package>]`, for messages. */
  label: string
  /** The C/C++ export target, and its directory: the ESP-IDF component. */
  file: string
  dir: string
}

export function packageNameOf(specifier: string): string
export function findPackageDir(name: string, fromDir: string): string | undefined
export function isNativeSource(file: string): boolean
export function nativeModuleOf(file: string): NativeModule
export function resolveNativeModule(specifier: string, fromDir: string): NativeModule | undefined
