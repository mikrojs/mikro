import prettyMs from 'pretty-ms'

export function short(ms: number): string {
  return prettyMs(ms, {compact: true})
}
