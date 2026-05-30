import {send} from './report.js'
import {read} from './sensor.js'

const g = globalThis as unknown as {__phaseEvals?: Record<string, number>}
g.__phaseEvals ??= {}
g.__phaseEvals.index = (g.__phaseEvals.index ?? 0) + 1

export function run(): string {
  return send(read())
}
