/** Semicolon-separated CMake lists; empty strings where nothing applies. */
export interface FirmwareInputs {
  components: string
  /** Import specifiers of the native modules compiled in. */
  nativeModules: string
  sdkconfigs: string
  /** Files read while resolving, for CMAKE_CONFIGURE_DEPENDS. */
  configureDepends: string
}

export function resolveFirmwareInputs(
  projectDir: string,
  declared?: {nativeModules?: string[]},
): Promise<FirmwareInputs>
