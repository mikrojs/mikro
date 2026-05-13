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

export interface MikroJSWifiConfig {
  /** Two-letter ISO 3166-1 country code for the WiFi regulatory domain. */
  country?: WifiCountryCode
  /** DHCP hostname advertised by the STA interface. Defaults to
   * `mikrojs-<device-id>` when unset. RFC 1123: letters, digits, hyphens
   * only; must not start or end with a hyphen; max 63 chars. */
  hostname?: string
}

export type LogFlush = 'line' | 'error'

export interface MikroJSLogFileOptions {
  /** Directory on the device filesystem where the log file lives. The
   * actual file is always `<dir>/log.txt` (rotated as `log.txt.1`).
   * Default: '/appfs/logs'. */
  dir?: string
  /** Maximum file size before rotation. Number of bytes, or string with
   * K/M suffix (e.g. '64k', '1m'). At cap, `log.txt` is renamed to
   * `log.txt.1` (replacing any previous generation) and a fresh
   * `log.txt` is started. Total flash usage is bounded at 2 × maxSize.
   * Default: '64k'. */
  maxSize?: number | string
  /** When to commit buffered writes to flash. 'line' flushes after every
   * newline (strongest post-mortem guarantee, hardest on flash). 'error'
   * buffers in RAM and flushes on warn/error lines or when the buffer
   * fills. Default: 'error'. */
  flush?: LogFlush
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
  wifi?: MikroJSWifiConfig
  /** File logging to the device filesystem. Captures console output and
   * native log calls into a rotated log file for post-mortem debugging.
   * Use `true` for defaults, or an options object to override individual
   * settings. Omit to disable. */
  logFile?: true | MikroJSLogFileOptions
  /** Simulator-only options. Stripped from the bundled config before deploy. */
  sim?: MikroJSSimConfig
  /** Build-time options. Stripped from the bundled config before deploy. */
  build?: MikroJSBuildConfig
}
export function defineConfig<T extends MikroJSConfig>(config: T) {
  return config
}
