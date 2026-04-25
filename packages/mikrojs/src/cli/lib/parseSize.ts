/**
 * Parse a size value with optional K/M/G suffix into bytes.
 * Accepts numbers (passed through) or strings like "300k", "1.5M", "2g".
 */
export function parseSize(value: number | string): number {
  if (typeof value === 'number') return value
  const match = value.match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i)
  if (!match) {
    throw new Error(
      `Invalid size: ${value}. Use a number with optional K/M/G suffix (e.g. 300K, 1M)`,
    )
  }
  const num = parseFloat(match[1]!)
  const unit = (match[2] || '').toLowerCase()
  switch (unit) {
    case 'k':
      return num * 1024
    case 'm':
      return num * 1024 * 1024
    case 'g':
      return num * 1024 * 1024 * 1024
    default:
      return num
  }
}
