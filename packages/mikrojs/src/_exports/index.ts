export type WifiCountryCode =
  | 'AT'
  | 'AU'
  | 'BE'
  | 'BG'
  | 'BR'
  | 'CA'
  | 'CH'
  | 'CN'
  | 'CY'
  | 'CZ'
  | 'DE'
  | 'DK'
  | 'EE'
  | 'ES'
  | 'FI'
  | 'FR'
  | 'GB'
  | 'GR'
  | 'HK'
  | 'HR'
  | 'HU'
  | 'IE'
  | 'IN'
  | 'IS'
  | 'IT'
  | 'JP'
  | 'KR'
  | 'LI'
  | 'LT'
  | 'LU'
  | 'LV'
  | 'MT'
  | 'MX'
  | 'NL'
  | 'NO'
  | 'NZ'
  | 'PL'
  | 'PT'
  | 'RO'
  | 'SE'
  | 'SI'
  | 'SK'
  | 'TW'
  | 'US'

export interface MikroJSSimConfig {
  /** QuickJS heap memory limit. Number of bytes, or string with K/M suffix (e.g. '300k'). */
  memLimit?: number | string
  /** Virtual filesystem size limit. Number of bytes, or string with K/M suffix (e.g. '1m'). */
  fsLimit?: number | string
  /** Filesystem sandbox root directory. Defaults to .mikro/sim-fs. */
  fsRoot?: string
}

export type Minifier = 'esbuild' | 'terser' | 'swc'
export type MinifyLevel = 'default' | 'max'
export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug'

export interface MikroJSBuildConfig {
  /** Bundle user code into a single module via esbuild, with tree-shaking.
   * Firmware builtins (mikrojs/*, native:*, and @mikrojs/* packages
   * with native code) stay external. Reduces QuickJS per-module overhead
   * and strips unused code paths, at the cost of less informative stack
   * traces. Default: false (per-file transform). */
  bundle?: boolean
  /** Which minifier to use. Requires the corresponding package to be
   * installed: 'terser' for terser, '@swc/core' for swc. esbuild is
   * always available. Default: 'esbuild'. */
  minifier?: Minifier
  /** Minification level. 'default' uses safe transforms only. 'max' enables
   * unsafe transforms (multiple compress passes, toplevel mangling,
   * pure_getters, unsafe_arrows, unsafe_math, unsafe_methods) for the
   * smallest possible output. Default: 'default'. */
  minifyLevel?: MinifyLevel
  /** Build-time log level. Console methods below this threshold are
   * eliminated as dead code by the minifier (via `pure_funcs`). For
   * helper functions that compute values only used in log calls,
   * annotate with `@__PURE__` so the minifier can cascade the removal:
   *
   * ```ts
   * const m = \/\* @__PURE__ \*\/ memoryUsage()
   * console.log(`[mem] heap: ${m.heapUsed}`)
   * // both statements eliminated at logLevel: 'warn'
   * ```
   *
   * Levels from most to least verbose: 'debug' > 'info' > 'warn' > 'error' > 'none'.
   * CLI `--loglevel` flag overrides this setting. Default: 'debug' (keep all). */
  logLevel?: LogLevel
}

export interface MikroJSConfig {
  restartOnUncaughtException?: boolean
  restartDelay?: number
  stackSize?: number
  memReserved?: number
  /** Maximum size in bytes for a single readFile() call. Files larger than
   * this throw FSError with code 'EFBIG' — use open() + read() to stream
   * larger files chunk-by-chunk. Number of bytes, or string with K/M
   * suffix (e.g. '128k', '1m'). Default: 65536 (64 KiB). */
  fsReadMax?: number | string
  wifiCountry?: WifiCountryCode
  /** Simulator-only options. Stripped from the bundled config before deploy. */
  sim?: MikroJSSimConfig
  /** Build-time options. Stripped from the bundled config before deploy. */
  build?: MikroJSBuildConfig
}
export function defineConfig<T extends MikroJSConfig>(config: T) {
  return config
}
