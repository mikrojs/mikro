import {existsSync, readFileSync, writeFileSync} from 'node:fs'

/**
 * Heap-baseline snapshot stored beside each test file as
 * `<name>.test.heap-baseline.json`. Keyed by chip (e.g. "esp32c6", "host")
 * because heap deltas differ across pointer size, native module availability,
 * and sdkconfig defaults. Committed to the repo; diffs show up in PR review.
 */
export interface HeapBaselineFile {
  [chip: string]: {heapDelta: number}
}

export function baselineFilePath(testFile: string): string {
  // Strip the script extension so the snapshot is `foo.test.heap-baseline.json`
  // rather than `foo.test.ts.heap-baseline.json` — the `.ts` has no meaning
  // once the test has been compiled and run.
  const base = testFile.replace(/\.(?:ts|tsx|js|mjs)$/, '')
  return `${base}.heap-baseline.json`
}

export function readBaseline(testFile: string, chip: string): number | undefined {
  const path = baselineFilePath(testFile)
  if (!existsSync(path)) return undefined
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as HeapBaselineFile
    return data[chip]?.heapDelta
  } catch {
    return undefined
  }
}

export function writeBaseline(testFile: string, chip: string, heapDelta: number): void {
  const path = baselineFilePath(testFile)
  let data: HeapBaselineFile = {}
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, 'utf-8')) as HeapBaselineFile
    } catch {
      data = {}
    }
  }
  data[chip] = {heapDelta}
  // Sort keys for stable output across runs
  const sorted: HeapBaselineFile = {}
  for (const key of Object.keys(data).sort()) sorted[key] = data[key]!
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n')
}
