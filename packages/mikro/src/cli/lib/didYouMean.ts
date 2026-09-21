/** Closest candidate to `input` by edit distance, for "did you mean" hints.
 * Returns undefined when nothing is close enough to be a plausible typo. */
export function didYouMean(input: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  const threshold = Math.max(2, Math.floor(input.length / 3))
  return bestDistance <= threshold ? best : undefined
}

function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const next = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diagonal + cost)
      diagonal = prev[j]!
      prev[j] = next
    }
  }
  return prev[b.length]!
}
