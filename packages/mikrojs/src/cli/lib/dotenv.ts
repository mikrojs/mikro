/** Simple .env file parser */

export interface EnvEntry {
  key: string
  value: string
}

/**
 * Parse a .env file into key-value pairs.
 * Supports:
 * - KEY=value
 * - KEY="quoted value"
 * - KEY='single quoted value'
 * - # comments
 * - Empty lines
 */
export function parseDotenv(content: string): EnvEntry[] {
  const entries: EnvEntry[] = []

  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue

    const key = line.slice(0, eqIdx).trim()
    let value = line.slice(eqIdx + 1).trim()

    // Strip matching quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (key) {
      entries.push({key, value})
    }
  }

  return entries
}
