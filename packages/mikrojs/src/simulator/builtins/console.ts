import type {BuiltinDefinition} from './types.js'

/**
 * Console builtin uses a raw source string because it patches globalThis.console
 * rather than exporting a native:* module. This is a special case — all other
 * builtins use the methods/RPC pattern.
 */
export const consoleBuiltin: BuiltinDefinition = {
  source: `
import { send } from 'native:host'
import { inspect } from 'mikrojs/inspect'

function format(args) {
  return JSON.stringify(args.map(a => typeof a === 'string' ? a : inspect(a)))
}

globalThis.console = {
  log(...args) { send('console:log', format(args)) },
  warn(...args) { send('console:warn', format(args)) },
  error(...args) { send('console:error', format(args)) },
  info(...args) { send('console:info', format(args)) },
  debug(...args) { send('console:debug', format(args)) },
}
`,
}
