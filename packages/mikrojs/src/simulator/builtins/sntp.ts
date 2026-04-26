import type {BuiltinDefinition} from './types.js'

// sntp uses a raw source module instead of RPC because the native sync()
// returns {ok, value: Promise<...>} which can't survive JSON serialization.
export const sntpBuiltin: BuiltinDefinition = {
  source: `
import {ok} from 'mikrojs/result'

export function sync(_servers, _timezone, _background) {
  return ok(Promise.resolve(ok({time: Date.now()})))
}
export function stop() {}
export function setTimezone(_tz) {}
`,
}
