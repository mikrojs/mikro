import {value} from './dep.js'

const g = globalThis as unknown as {__phaseEvals?: Record<string, number>}
g.__phaseEvals ??= {}
g.__phaseEvals.sharedHolder = (g.__phaseEvals.sharedHolder ?? 0) + 1

// Kept alive (never disposed) so it pins ./dep.js across a phase disposal.
export function read(): number {
  return value()
}
