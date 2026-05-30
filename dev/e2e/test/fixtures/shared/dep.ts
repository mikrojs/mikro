// A dependency imported by BOTH a disposable phase and a long-lived holder.
// When the phase is disposed, this must NOT be unloaded, because the holder
// still imports it (its importer set never becomes empty).
const g = globalThis as unknown as {__phaseEvals?: Record<string, number>}
g.__phaseEvals ??= {}
g.__phaseEvals.sharedDep = (g.__phaseEvals.sharedDep ?? 0) + 1

export function value(): number {
  return 7
}
