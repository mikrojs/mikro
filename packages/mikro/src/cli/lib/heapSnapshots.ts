import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import * as pathlib from 'node:path'

/** Directory under the project root holding the committed heap snapshots. */
const SNAPSHOT_DIR = '__heap_snapshots__'

/**
 * Heap snapshots for one chip, stored as `__heap_snapshots__/<chip>.json` under
 * the project root. One file per chip because a run targets a single chip: the
 * diff stays one file wide. Split by chip rather than by test because heap
 * deltas differ across pointer size, native module availability, and sdkconfig
 * defaults. Committed to the repo; diffs show up in PR review.
 *
 * Per-test measurements nest under `tests`, keyed by project-relative test path,
 * so the file can also carry chip-wide figures without a key that means "test
 * path" sitting beside one that doesn't. Unknown top-level keys are preserved
 * on write.
 */
interface HeapSnapshotFile {
  /** What the device leaves for an app to consume, read from the ready
   *  handshake and captured before the app was evaluated. Moves with the
   *  firmware and the project's runtime config, not with app code. Written by
   *  `mikro profile`, never by a test run.
   *
   *  Two ceilings, because either can bind first: `heapFree` is the JS budget
   *  left before `mem_limit` throws, and `systemFree` is the chip heap that
   *  native allocations (TLS records, WiFi buffers, drivers) draw on. QuickJS
   *  allocates out of the system heap, so JS growth is capped by whichever is
   *  smaller.
   *
   *  Not independent: `mem_limit` is derived as free heap minus `memReserved`,
   *  so raising that reserve lowers `heapFree` one-for-one while leaving
   *  `systemFree` alone. `memReserved` is recorded alongside them so a diff
   *  shows which of the two happened. */
  boot?: {heapFree: number; systemFree: number; memReserved: number}
  tests: {[testPath: string]: {heapDelta: number}}
}

export function snapshotFilePath(root: string, chip: string): string {
  return pathlib.join(root, SNAPSHOT_DIR, `${chip}.json`)
}

/** Project-relative, forward-slashed, so keys are identical on any platform. */
function snapshotKey(root: string, testFile: string): string {
  return pathlib.relative(root, testFile).split(pathlib.sep).join('/')
}

function readFile(path: string): HeapSnapshotFile {
  if (!existsSync(path)) return {tests: {}}
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Partial<HeapSnapshotFile>
    return {...data, tests: data.tests ?? {}}
  } catch {
    return {tests: {}}
  }
}

export function readSnapshot(root: string, testFile: string, chip: string): number | undefined {
  const data = readFile(snapshotFilePath(root, chip))
  return data.tests[snapshotKey(root, testFile)]?.heapDelta
}

export type BootFigures = NonNullable<HeapSnapshotFile['boot']>

export function readBootSnapshot(root: string, chip: string): BootFigures | undefined {
  return readFile(snapshotFilePath(root, chip)).boot
}

/** Leaves `tests` untouched: pruning is a test-run concern, not this one. */
export function writeBootSnapshot(root: string, chip: string, boot: BootFigures): void {
  const path = snapshotFilePath(root, chip)
  const data = readFile(path)
  writeAtomic(path, {...data, boot})
}

export function writeSnapshot(
  root: string,
  testFile: string,
  chip: string,
  heapDelta: number,
): void {
  const path = snapshotFilePath(root, chip)
  const data = readFile(path)
  const key = snapshotKey(root, testFile)
  const tests = {...data.tests, [key]: {heapDelta}}

  // Sort for stable diffs, and drop entries whose test file is gone. The old
  // one-file-per-test layout self-pruned by being visible; an orphan key inside
  // a shared file is not. Keyed off the file existing, so a filtered run can't
  // delete entries it simply didn't cover.
  const next: HeapSnapshotFile['tests'] = {}
  for (const k of Object.keys(tests).sort()) {
    if (k !== key && !existsSync(pathlib.join(root, k))) continue
    next[k] = tests[k]!
  }

  writeAtomic(path, {...data, tests: next})
}

/**
 * One file holds a whole chip's measurements, so a kill mid-write would lose all
 * of them rather than a single test's. Write to a temp file, then rename.
 */
function writeAtomic(path: string, data: HeapSnapshotFile): void {
  mkdirSync(pathlib.dirname(path), {recursive: true})
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, path)
}

/**
 * Lower bound on the drift worth recording. Anything the comparison flags must
 * also be something `--update-heap` will write, or a small drift warns forever
 * while the update refuses to clear it.
 */
export function heapTolerance(stored: number, override?: number): number {
  return override ?? Math.max(256, Math.floor(stored * 0.01))
}

/**
 * Classify a measured free-heap figure against the stored one.
 *
 * Free heap is a fixed expected value rather than a ceiling with room under it,
 * so the band is symmetric: less free than recorded is a regression, more free
 * is an improvement worth recording.
 *
 * Deliberately not `classifyHeapSnapshot`, whose 25%-of-stored `stale` margin
 * suits small retained-heap numbers — on a ~240KB figure that margin is ~60KB,
 * so it would never fire.
 */
export function classifyBootSnapshot(
  free: number,
  stored: number,
  tolerance: number,
): 'ok' | 'exceeded' | 'stale' {
  if (free < stored - tolerance) return 'exceeded'
  if (free > stored + tolerance) return 'stale'
  return 'ok'
}

/**
 * Classify a measured retained-heap delta against the stored one.
 *
 * `stale` means the run came in well under the stored value, so the saved
 * number is out of date. Recording the lower one keeps the check useful: the
 * old value would let that much growth back in without a word.
 *
 * The margin uses the same tolerance as the upper band, so a wide
 * `--heap-tolerance` cannot report `stale` on something `--update-heap` then
 * refuses to write.
 */
export function classifyHeapSnapshot(
  delta: number,
  stored: number,
  tolerance: number,
): 'ok' | 'exceeded' | 'stale' {
  if (delta > stored + tolerance) return 'exceeded'
  const margin = Math.max(tolerance, Math.floor(stored * 0.25))
  return delta < stored - margin ? 'stale' : 'ok'
}
