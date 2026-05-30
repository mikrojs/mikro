import {lookup} from './util.js'

const g = globalThis as unknown as {__phaseEvals?: Record<string, number>}
g.__phaseEvals ??= {}
g.__phaseEvals.report = (g.__phaseEvals.report ?? 0) + 1

export function send(value: string): string {
  return `${lookup(0)}/${value}`
}
