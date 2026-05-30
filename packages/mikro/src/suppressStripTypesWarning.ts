// TEMPORARY: remove this module (and its imports) once node:module type
// stripping is no longer experimental and Node stops emitting the warning.
//
// node:module.stripTypeScriptTypes emits an ExperimentalWarning on its first
// call. It carries no warning code, so it can't be silenced with a targeted
// node flag (`--disable-warning` only accepts a code or the broad type
// `ExperimentalWarning`, which would swallow every experimental warning). We
// strip .ts files at build, config-load, and sim time, so it fires on nearly
// every CLI run with nothing the user can act on. Intercept process.emitWarning
// and drop just this one message, leaving all other warnings intact.
//
// Import this module for its side effect before any code path that may call
// stripTypeScriptTypes.
const originalEmitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const message =
    typeof warning === 'string' ? warning : (warning as {message?: string} | undefined)?.message
  if (message?.includes('stripTypeScriptTypes')) return
  return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning
