/** Simple .env file parser */

export interface EnvEntry {
  key: string
  value: string
  /**
   * True when a `# @no-secret` annotation appears in the contiguous comment
   * block immediately preceding this entry. Otherwise the entry is treated
   * as secret by default.
   */
  noSecret: boolean
}

const NO_SECRET_RE = /(^|\s)@no-secret(\s|$)/

/**
 * Parse a .env file into key-value pairs.
 *
 * Supports:
 * - KEY=value
 * - KEY="quoted value"
 * - KEY='single quoted value'
 * - # comments
 * - Empty lines (reset the pending @no-secret annotation)
 * - `# @no-secret` annotation on a comment line in the contiguous comment
 *   block directly above a KEY=VALUE line; marks that one entry non-secret.
 */
export function parseDotenv(content: string): EnvEntry[] {
  const entries: EnvEntry[] = []
  let pendingNoSecret = false

  for (const raw of content.split('\n')) {
    const line = raw.trim()

    if (!line) {
      pendingNoSecret = false
      continue
    }

    if (line.startsWith('#')) {
      if (NO_SECRET_RE.test(line)) pendingNoSecret = true
      continue
    }

    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) {
      pendingNoSecret = false
      continue
    }

    const key = line.slice(0, eqIdx).trim()
    let value = line.slice(eqIdx + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (key) {
      entries.push({key, value, noSecret: pendingNoSecret})
    }
    pendingNoSecret = false
  }

  return entries
}
