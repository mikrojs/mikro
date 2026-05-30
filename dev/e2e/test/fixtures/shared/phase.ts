import {value} from './dep.js'

const g = globalThis as unknown as {__phaseEvals?: Record<string, number>}
g.__phaseEvals ??= {}
g.__phaseEvals.sharedPhase = (g.__phaseEvals.sharedPhase ?? 0) + 1

export function compute(): number {
  return value() * 2
}
