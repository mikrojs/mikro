import {lookup} from './util.js'

const g = globalThis as unknown as {__phaseEvals?: Record<string, number>}
g.__phaseEvals ??= {}
g.__phaseEvals.sensor = (g.__phaseEvals.sensor ?? 0) + 1

export function read(): string {
  return lookup(3)
}
