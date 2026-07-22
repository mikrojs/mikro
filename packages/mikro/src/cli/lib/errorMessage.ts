/**
 * Flatten an error and its `cause` chain into one line.
 *
 * Top-level CLI handlers have to render an error as text, and `err.message`
 * alone drops the chain: a failed check-in surfaces as "fetch failed" while the
 * part worth reading (ECONNREFUSED, a TLS error, the url) sits in `cause`.
 * Prefer passing the error object itself to `console.error` where the output is
 * for a human — Node prints the chain. Use this where a string is required,
 * such as the `--json` and agent-mode envelopes.
 */
export function describeError(err: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  let current: unknown = err
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    parts.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(': ')
}
