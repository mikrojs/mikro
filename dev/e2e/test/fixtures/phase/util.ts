// Shared leaf of the phase tree (imported by both sensor and report, so it
// becomes an orphan only when the whole tree is unloaded). Carries a sizeable
// payload so disposing the tree reclaims clearly-measurable heap, and bumps a
// per-module eval counter.
const g = globalThis as unknown as {__phaseEvals?: Record<string, number>}
g.__phaseEvals ??= {}
g.__phaseEvals.util = (g.__phaseEvals.util ?? 0) + 1

// ~1024 distinct strings: tens of KB of retained heap while loaded.
export const TABLE: readonly string[] = Array.from(
  {length: 1024},
  (_, i) => `entry-${i.toString().padStart(6, '0')}`,
)

export function lookup(i: number): string {
  return TABLE[i % TABLE.length] as string
}
