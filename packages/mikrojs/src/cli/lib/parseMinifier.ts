import type {LogLevel, Minifier, MinifyLevel} from '../../_exports/index.js'

const VALID_MINIFIERS = new Set<Minifier>(['esbuild', 'terser', 'swc'])
const VALID_MINIFY_LEVELS = new Set<MinifyLevel>(['default', 'max'])
const VALID_LOG_LEVELS = new Set<LogLevel>(['none', 'error', 'warn', 'info', 'debug'])

export function parseMinifier(value: string | undefined): Minifier | undefined {
  if (value === undefined) return undefined
  if (VALID_MINIFIERS.has(value as Minifier)) return value as Minifier
  throw new Error(`Invalid minifier '${value}'. Must be one of: esbuild, terser, swc`)
}

export function parseMinifyLevel(value: string | undefined): MinifyLevel | undefined {
  if (value === undefined) return undefined
  if (VALID_MINIFY_LEVELS.has(value as MinifyLevel)) return value as MinifyLevel
  throw new Error(`Invalid minify level '${value}'. Must be one of: default, max`)
}

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) return undefined
  if (VALID_LOG_LEVELS.has(value as LogLevel)) return value as LogLevel
  throw new Error(`Invalid log level '${value}'. Must be one of: none, error, warn, info, debug`)
}

/** Numeric severity, higher = noisier. Mirrors
 *  `LOG_LEVEL_PURE_FUNCS` in build.ts: at threshold `info`, `console.debug`
 *  is dropped; at `warn`, `log`/`info` are dropped too; etc. */
const LEVEL_SEVERITY: Record<'error' | 'warn' | 'info' | 'log' | 'debug', number> = {
  error: 1,
  warn: 2,
  info: 3,
  log: 3,
  debug: 4,
}

const THRESHOLD_SEVERITY: Record<LogLevel, number> = {
  none: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

/** Whether an event of severity `eventLevel` should be surfaced when the
 *  configured threshold is `threshold`. Host-side backstop for the
 *  build-time DCE (which can leak in callback-position `console.debug`
 *  calls). */
export function logLevelAllows(
  threshold: LogLevel,
  eventLevel: 'error' | 'warn' | 'info' | 'log' | 'debug',
): boolean {
  return LEVEL_SEVERITY[eventLevel] <= THRESHOLD_SEVERITY[threshold]
}
