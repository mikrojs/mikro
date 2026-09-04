import {existsSync, readFileSync, statSync} from 'node:fs'
import {glob} from 'node:fs/promises'
import * as pathlib from 'node:path'

import {
  catchError,
  finalize,
  firstValueFrom,
  last,
  lastValueFrom,
  merge,
  of,
  scan,
  Subject,
  takeWhile,
  tap,
} from 'rxjs'

import type {Minifier, MinifyLevel} from '../../_exports/index.js'
import {buildTests, entryRootDir} from './build.js'
import {collectFiles, type EnvVar} from './deploy.js'
import {
  applyBootSnapshot,
  type BootFigures,
  type BootSnapshotAction,
  classifyHeapSnapshot,
  DEFAULT_MEM_RESERVED,
  heapTolerance,
  readSnapshot,
  sysTolerance,
  type TestFigures,
  writeSnapshot,
} from './heapSnapshots.js'
import {resolveProjectRoot} from './projectRoot.js'
import type {DeployEvent, ReplEvent, ReplSession, TestEvent} from './session.js'

/**
 * Resolve the deploy root directory for a test run.
 *
 * Firmware and sim deploy-done atomically promote only `<staging>/app/` to the
 * live app dir; anything outside that subtree is dropped. So the build output
 * must live under an `app/` root that matches the user's project convention.
 *
 * We derive this from the package.json "main" field (e.g. `./app/main.ts` →
 * `app`). Fall back to `app` if main is missing, matching the convention used
 * by every example in this repo.
 */
function resolveAppRoot(cwd: string): string {
  const pkgPath = pathlib.join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (typeof pkg.main === 'string') {
        const rel = pathlib.relative(cwd, pathlib.resolve(cwd, pkg.main))
        const dir = entryRootDir(rel)
        if (dir !== '.') return dir
      }
    } catch {
      // Fall through to default
    }
  }
  return 'app'
}

export type HeapSnapshotAction = 'created' | 'ok' | 'exceeded' | 'updated' | 'stale' | 'skipped'

export interface TestFileResult {
  file: string
  passed: number
  failed: number
  skipped: number
  todo: number
  duration: number
  events: TestEvent[]
  error?: string
  /** True once the file's run_done (e:6) arrived. A result without this
   *  and without an error means the file was never accounted — the
   *  finalization pass turns that into an error so totals can't report
   *  PASS over files that silently never ran. */
  completed?: boolean
  /** heapUsed delta (bytes) between run start and end, after gc on both
   *  sides. Relative to the (post-beforeAll) baseline; drives heap-snapshot
   *  regression tracking. Surfaced as the "retained" figure (the only memory
   *  signal on the host sim, which has no system heap). */
  heapDelta?: number
  /** Memory the suite used (bytes): how far free system heap fell from the
   *  baseline to its sampled low-water. Device-only. */
  sysUsed?: number
  /** Lowest free system heap (bytes) sampled during the run: the suite's
   *  closest sampled approach to OOM. `sysUsed + sysMinFree ≈ baseline free`.
   *  Per-file (the device runs each file in a fresh runtime). Device-only
   *  (absent on the host sim). */
  sysMinFree?: number
  /** Net timer count change between run start and end (should be 0) */
  timerDelta?: number
  /** Net in-flight HTTP request count change (should be 0). Detects fetches
   *  that were initiated but not cancelled or awaited before teardown. */
  pendingDelta?: number
  /** Chip reported by the device (e.g. "esp32c6", "simulator"). Snapshot key. */
  chip?: string
  /** Per-suite retention and peak, in run order. Attribution for a file-level
   *  regression: the snapshot says the file grew, this says which suite did
   *  it. Deliberately not snapshotted — suite names churn, and a per-suite
   *  delta is too small to gate on. */
  suites?: {name: string; retained: number; sysUsed?: number}[]
  /** Stored snapshot value for this chip (if a snapshot existed) */
  heapSnapshotStored?: number
  /** Stored peak for this chip, when the snapshot recorded one. */
  sysUsedStored?: number
  /** On an `updated` action, the value that was there before. `heapSnapshotStored`
   *  holds the newly written one, so the diff needs both. */
  heapSnapshotPrevious?: number
  /** What happened to the heap snapshot this run */
  heapSnapshotAction?: HeapSnapshotAction
  /** On an `exceeded` action, the figures that cleared their tolerance. A
   *  regression in either one trips the gate, so the message and the suite
   *  breakdown need to know which. */
  heapSnapshotExceeded?: HeapFigure[]
}

/** The two per-file figures a snapshot gates on. */
export type HeapFigure = 'retained' | 'peak'

/** The boot figures a run read from the ready handshake, and what became of
 *  the chip's boot snapshot. Device-only: the host sim reports no memory
 *  figures, so a sim run produces none of this. */
export interface BootSnapshotResult {
  chip: string
  measured: BootFigures
  /** The figures on file before this run. Absent when nothing was recorded. */
  stored?: BootFigures
  action: BootSnapshotAction
}

export interface TestRunOptions {
  minify: boolean
  bytecode: boolean
  minifier?: Minifier
  minifyLevel?: MinifyLevel
  envVars: EnvVar[]
  timeout: number
  buildDir: string
  /** Value of MIKRO_ENV to set during the test run (e.g. 'test', 'simulator'). */
  mikroEnv: string
  /** If true, write the current heapDelta (and boot figures) as the new
   *  snapshot for the current chip. */
  updateHeapSnapshots?: boolean
  /** Drift (bytes) below which a snapshot is neither flagged nor rewritten.
   *  Undefined uses max(256B, 1% of stored). */
  heapTolerance?: number
}

/**
 * Resolve test files from a list of patterns. Each pattern may be:
 *   - an explicit path to an existing file (included directly)
 *   - a glob pattern (expanded against cwd, excluding node_modules/build)
 *
 * With no patterns, falls back to the default `**\/*.test.ts` glob. Patterns
 * that match nothing throw — a typo in a path shouldn't silently run zero
 * tests.
 */
export async function discoverTestFiles(
  cwd: string,
  patterns: readonly string[] = [],
): Promise<string[]> {
  const effective = patterns.length === 0 ? ['**/*.test.ts'] : patterns
  const results = new Set<string>()
  for (const pattern of effective) {
    const abs = pathlib.resolve(cwd, pattern)
    if (existsSync(abs) && statSync(abs).isFile()) {
      results.add(abs)
      continue
    }
    let matched = 0
    for await (const m of glob(pattern, {cwd, exclude: ['node_modules/**', 'build/**']})) {
      results.add(pathlib.resolve(cwd, m))
      matched++
    }
    if (matched === 0) {
      throw new Error(`No test files matched: ${pattern}`)
    }
  }
  return Array.from(results).sort()
}

export interface TestManifestCallbacks {
  /** Called with the test file about to start (based on deploy manifest order). */
  onFileStart?: (file: string, index: number, total: number) => void
  /** Called when a file's run_done event arrives, closing out its result. */
  onFileDone?: (result: TestFileResult, index: number, total: number) => void
  /** Per-event hook (suite/test events). */
  onEvent?: (event: TestEvent, file: string) => void
  /** Console output forwarding. */
  onLog?: (level: string, text: string, file: string) => void
  /** Deploy-phase progress. Fired for each DeployEvent before tests start. */
  onDeployEvent?: (event: DeployEvent) => void
  /** Fired once after the deploy, before the first file runs, when the device
   *  reported its boot figures. */
  onBoot?: (result: BootSnapshotResult) => void
  /** Generic progress messages. */
  log?: (msg: string) => void
}

/**
 * Build the test manifest, deploy once, and observe the device supervisor
 * stream as each test file runs in its own fresh runtime. Returns one
 * TestFileResult per input, with heap-snapshot bookkeeping applied.
 */
export async function runTestManifest(
  session: ReplSession,
  testFiles: string[],
  options: TestRunOptions,
  cb: TestManifestCallbacks = {},
): Promise<TestFileResult[]> {
  const cwd = process.cwd()
  const rootDir = resolveAppRoot(cwd)
  const relPaths = testFiles.map((f) => pathlib.relative(cwd, f))

  cb.log?.('Building test manifest...')
  await lastValueFrom(
    buildTests(relPaths, options.buildDir, {
      minify: options.minify,
      bytecode: options.bytecode,
      minifier: options.minifier,
      minifyLevel: options.minifyLevel,
      rootDir,
      // Tests resolve the `test` config env. (The granular .env.<mode> the run
      // loads is tracked separately via mikroEnv.)
      env: 'test',
    }),
    {defaultValue: undefined},
  )

  const files = await collectFiles(options.buildDir)
  cb.log?.(`Deploying ${files.length} file(s)`)
  // Incremental deploy: the device-side supervisor only executes paths
  // listed in package.json's `tests` array, so stale files from a prior
  // run are benign (they just sit in flash). Letting the checksum-based
  // KEEP path run makes re-running `mikro test` after a one-file edit
  // upload only the changed file instead of the whole manifest.
  await lastValueFrom(
    session
      .deploy({
        files,
        envVars: [{key: 'MIKRO_ENV', value: options.mikroEnv, secret: false}, ...options.envVars],
        restart: true,
        // Each test run needs a fresh runtime so the supervisor re-evaluates
        // the manifest. Without this, a re-run with unchanged files + env
        // short-circuits to abort+no-restart and the device stays in whatever
        // state the previous run left it in.
        alwaysRestart: true,
      })
      .pipe(tap((event) => cb.onDeployEvent?.(event))),
  )

  // Resolve chip before streaming so heap-snapshot bookkeeping can run
  // synchronously inside onFileDone — otherwise the per-file render happens
  // before heapSnapshotAction is set and the user sees no feedback.
  // ready$ is shareReplay(1) and session.deploy() awaits ready, so this is
  // cached and resolves immediately.
  const ready = await firstValueFrom(session.ready$)
  const chip = ready.chip ?? 'unknown'
  const snapshotRoot = resolveProjectRoot()

  // The same handshake carries what the device left for an app, captured at
  // boot before the supervisor allocated anything, so it describes the app
  // floor rather than this run. Free to read, so record it here instead of
  // asking for a separate `mikro profile`. Absent on the host sim and on
  // firmware predating the field.
  if (ready.heapFree !== undefined && ready.systemFree !== undefined) {
    const measured: BootFigures = {
      heapFree: ready.heapFree,
      systemFree: ready.systemFree,
      memReserved: ready.memReserved ?? DEFAULT_MEM_RESERVED,
    }
    const outcome = applyBootSnapshot(snapshotRoot, chip, measured, {
      seed: true,
      update: options.updateHeapSnapshots === true,
      tolerance: options.heapTolerance,
    })
    cb.onBoot?.({chip, measured, ...outcome})
  }

  const wrappedCb: TestManifestCallbacks = {
    ...cb,
    onFileDone: (result, index, total) => {
      applyHeapSnapshot(result, snapshotRoot, chip, options)
      cb.onFileDone?.(result, index, total)
    },
  }

  cb.log?.('Waiting for test results...')
  return await collectManifestEvents(session, testFiles, options.timeout, wrappedCb)
}

/**
 * Mutates `result` with chip + heap-snapshot bookkeeping fields and writes the
 * snapshot file when appropriate. Must run before the user-visible render of a
 * TestFileResult so messages like "heap snapshot exceeded" can appear alongside
 * the file's pass/fail summary.
 */
export function applyHeapSnapshot(
  result: TestFileResult,
  root: string,
  chip: string,
  options: Pick<TestRunOptions, 'updateHeapSnapshots' | 'heapTolerance'>,
): void {
  result.chip = chip
  if (typeof result.heapDelta !== 'number') return
  const stored = readSnapshot(root, result.file, chip)
  // A file that executed nothing measures the cost of an empty run, and a file
  // with failures measures a broken one (aborted tests leave debris resident):
  // seeding or updating from either would record garbage, and comparing
  // against it would warn forever about a figure -u must not accept. Leave
  // the snapshot alone, and say so when there is a stored figure the reader
  // might expect a comparison against. `todo` tests don't count: they are
  // permanent placeholders, not a sign this environment skipped the file.
  if (result.failed > 0 || (result.passed === 0 && result.skipped > 0)) {
    if (stored !== undefined) {
      result.heapSnapshotStored = stored.heapDelta
      result.sysUsedStored = stored.sysUsed
      result.heapSnapshotAction = 'skipped'
    }
    return
  }
  const measured: TestFigures = {
    heapDelta: result.heapDelta,
    ...(typeof result.sysUsed === 'number' ? {sysUsed: result.sysUsed} : {}),
  }
  // Seed a missing entry even without the flag, so a new test file or a chip
  // seen for the first time records itself instead of going unmeasured.
  if (stored === undefined) {
    writeSnapshot(root, result.file, chip, measured)
    result.heapSnapshotAction = 'created'
    result.heapSnapshotStored = measured.heapDelta
    result.sysUsedStored = measured.sysUsed
    return
  }
  result.heapSnapshotStored = stored.heapDelta
  result.sysUsedStored = stored.sysUsed
  // Retention and peak fail differently, so a regression in either counts,
  // the way either boot ceiling does. Each gets the band that suits it.
  const verdicts: {figure: HeapFigure; verdict: HeapSnapshotAction}[] = [
    {
      figure: 'retained',
      verdict: classifyHeapSnapshot(
        result.heapDelta,
        stored.heapDelta,
        heapTolerance(stored.heapDelta, options.heapTolerance),
      ),
    },
  ]
  if (typeof measured.sysUsed === 'number' && typeof stored.sysUsed === 'number') {
    verdicts.push({
      figure: 'peak',
      verdict: classifyHeapSnapshot(
        measured.sysUsed,
        stored.sysUsed,
        sysTolerance(stored.sysUsed, options.heapTolerance),
      ),
    })
  } else if (typeof measured.sysUsed === 'number') {
    // Recorded before peaks were tracked. Nothing to compare against, but the
    // entry is stale in the sense that matters: -u would add a figure.
    verdicts.push({figure: 'peak', verdict: 'stale'})
  }
  const moved = verdicts.some((v) => v.verdict !== 'ok')
  const exceeded = verdicts.filter((v) => v.verdict === 'exceeded').map((v) => v.figure)
  if (options.updateHeapSnapshots === true) {
    // Leave drift under the tolerance alone: rewriting on a couple of bytes
    // is pure diff noise.
    if (!moved) {
      result.heapSnapshotAction = 'ok'
      return
    }
    writeSnapshot(root, result.file, chip, measured)
    result.heapSnapshotAction = 'updated'
    result.heapSnapshotPrevious = stored.heapDelta
    result.heapSnapshotStored = measured.heapDelta
    result.sysUsedStored = measured.sysUsed
    return
  }
  if (exceeded.length > 0) {
    result.heapSnapshotAction = 'exceeded'
    result.heapSnapshotExceeded = exceeded
    return
  }
  result.heapSnapshotAction = moved ? 'stale' : 'ok'
}

/** Format a byte count for human-readable test output. */
export function formatBytes(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1024) return `${n}B`
  const kb = n / 1024
  if (abs < 1024 * 1024) {
    return Number.isInteger(kb) ? `${kb}KB` : `${kb.toFixed(1)}KB`
  }
  const mb = n / (1024 * 1024)
  return Number.isInteger(mb) ? `${mb}MB` : `${mb.toFixed(1)}MB`
}

/**
 * Memory portion of a file-summary line. Two distinct signals, labelled so the
 * number's meaning is on the label:
 *
 *   peak:     device only (system heap). How far free system heap dipped below
 *             the baseline at its sampled low (sysUsed), paired with that
 *             low-water (min free). A high-water mark: "the most this suite
 *             needed at once," including transient TLS/wifi buffers. Always >= 0.
 *   retained: both (JS heap). End-of-run heap minus baseline (heapDelta): bytes
 *             the suite still holds above baseline, i.e. what it didn't release.
 *             ~0 is good. Can be slightly negative when the run ends lighter than
 *             baseline (a reference cycle collected since baseline); read that as
 *             "clean," not "negative usage."
 */
export function formatMemorySummary(result: TestFileResult): string[] {
  const parts: string[] = []
  if (typeof result.sysUsed === 'number') {
    parts.push(`peak ${formatBytes(result.sysUsed)}`)
    if (typeof result.sysMinFree === 'number') {
      parts.push(`min free ${formatBytes(result.sysMinFree)}`)
    }
  }
  if (typeof result.heapDelta === 'number') {
    parts.push(`retained ${formatBytes(result.heapDelta)}`)
  }
  return parts
}

const green = (t: string) => `\x1b[32m${t}\x1b[0m`
const red = (t: string) => `\x1b[31m${t}\x1b[0m`
const yellow = (t: string) => `\x1b[33m${t}\x1b[0m`
const dim = (t: string) => `\x1b[2m${t}\x1b[0m`

/** One segment per ceiling, e.g. `js 218KB → 221KB (+3KB)`. More free is the
 *  win here, so the colours invert relative to the retained-heap diff. */
function figure(label: string, now: number, before: number | undefined): string {
  const value = formatBytes(now)
  if (before === undefined || before === now) return `${label} ${value}`
  const change = now - before
  const delta = change > 0 ? green(`+${formatBytes(change)}`) : red(formatBytes(change))
  return `${label} ${dim(`${formatBytes(before)} → ${value} (`)}${delta}${dim(')')}`
}

/**
 * The boot reading as one line, shared by `mikro test` and `mikro profile` so
 * the same figure doesn't render two ways:
 *
 *   esp32c6  js 218KB → 221KB (+3KB)   system 249.1KB → 252.4KB (+3.3KB)
 *
 * `updateFlag` is the option that would record the reading, which differs
 * between the two commands.
 */
export function formatBootLine(result: BootSnapshotResult, updateFlag: string): string {
  const {measured, stored} = result
  const body = `${figure('js', measured.heapFree, stored?.heapFree)}   ${figure(
    'system',
    measured.systemFree,
    stored?.systemFree,
  )}`
  const suffix =
    result.action === 'created'
      ? dim(' (wrote boot snapshot)')
      : result.action === 'updated'
        ? dim(' (updated boot snapshot)')
        : result.action === 'unrecorded'
          ? dim(` (nothing recorded yet; re-run with ${updateFlag} to record it)`)
          : result.action === 'exceeded'
            ? yellow(` ⚠ less than the stored figure. Re-run with ${updateFlag} to accept.`)
            : result.action === 'stale'
              ? dim(` (re-run with ${updateFlag} to record it)`)
              : ''
  return `${result.chip}  ${body}${suffix}`
}

/**
 * The "heap snapshot exceeded" line, shared by `mikro test` and `mikro sim
 * test`. Names only the figures that cleared their tolerance: retention and
 * peak have separate bands and either can trip the gate on its own, so listing
 * a few bytes of retained drift next to a real peak regression would point
 * the reader at the wrong number.
 */
export function formatHeapExceeded(result: TestFileResult, chip: string): string {
  const tripped = result.heapSnapshotExceeded ?? []
  const moved: string[] = []
  if (tripped.includes('retained')) {
    const over = (result.heapDelta ?? 0) - (result.heapSnapshotStored ?? 0)
    moved.push(`retained +${formatBytes(over)} over ${formatBytes(result.heapSnapshotStored ?? 0)}`)
  }
  if (tripped.includes('peak') && result.sysUsed !== undefined) {
    const over = result.sysUsed - (result.sysUsedStored ?? 0)
    moved.push(`peak +${formatBytes(over)} over ${formatBytes(result.sysUsedStored ?? 0)}`)
  }
  const body = moved.length > 0 ? moved.join(', ') : 'moved'
  return yellow(`⚠ heap snapshot exceeded for ${chip}: ${body}. Re-run with -u to accept.`)
}

/**
 * The suites behind a file-level regression, heaviest first. A file figure
 * says a file grew; without this the reader has to bisect by hand to find out
 * which part of it did. Ordered by the figure that tripped: when only the
 * peak regressed, the suite that retained the most is not the one to look at.
 */
export function formatSuiteBreakdown(result: TestFileResult): string[] {
  const suites = result.suites ?? []
  if (suites.length < 2) return []
  const tripped = result.heapSnapshotExceeded ?? []
  const byPeak = tripped.includes('peak') && !tripped.includes('retained')
  return [...suites]
    .sort((a, b) => (byPeak ? (b.sysUsed ?? 0) - (a.sysUsed ?? 0) : b.retained - a.retained))
    .slice(0, 3)
    .map((s) => {
      const peak = s.sysUsed === undefined ? '' : `, peak ${formatBytes(s.sysUsed)}`
      return dim(`    ${s.name}: retained ${formatBytes(s.retained)}${peak}`)
    })
}

function emptyResult(file: string): TestFileResult {
  return {
    file,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    duration: 0,
    events: [],
  }
}

/**
 * Demultiplex the device event stream per file. Each run_done (e:6) closes
 * the current file and advances the index; manifest_done ends the run.
 *
 * Readiness handling: the initial deploy restarts the device once, so a
 * single ready event is expected before test 1. Any subsequent ready event
 * (after test 1's first event) indicates an unexpected reboot — treat as a
 * crash and bail, returning partial results.
 */
/**
 * Observe the device event stream and produce one TestFileResult per test
 * file. Exported so the reducer's contract with the firmware supervisor
 * can be unit-tested without going through the real build+deploy path.
 */
export async function collectManifestEvents(
  session: ReplSession,
  testFiles: string[],
  timeoutMs: number,
  cb: TestManifestCallbacks,
): Promise<TestFileResult[]> {
  const debug = process.env.MIKRO_DEBUG_EVENTS === '1'

  /* Event-stream reducer: every incoming ReplEvent produces a new
   * ManifestState. Side effects are enqueued as `emits` and drained in
   * the tap stage, never inside the reducer itself. `done` is the sole
   * completion signal — takeWhile reads it to end the stream without
   * the race window that a Subject-based `takeUntil` creates (where an
   * event buffered into the same chunk as the terminator can be dropped). */
  type Emit =
    | {kind: 'file_start'; file: string; index: number}
    | {kind: 'file_done'; result: TestFileResult; index: number; file: string}
    | {kind: 'event'; event: TestEvent; file: string}
    | {kind: 'log'; level: string; text: string; file: string}

  interface ManifestState {
    index: number
    /** True once the current index has received at least one test event.
     * Used to decide whether to fire onFileStart on a supervisor-announce
     * transition — the initial file_start is emitted upfront. */
    seenAnyTestForIndex: boolean
    /** True after one full silent window (no events for timeoutMs). The
     * first window only warns: a slow TLS handshake can stall 60s+
     * without emitting while the file is healthy (seen on esp32c6, where
     * this used to abort the whole run). Any real event clears it; a
     * second consecutive silent window is treated as a dead device. */
    graceUsed: boolean
    results: TestFileResult[]
    done: boolean
    doneReason: 'manifest_done' | 'crash' | 'timeout' | 'disconnect' | null
    emits: Emit[]
  }

  /**
   * Match the firmware supervisor's announcement:
   *   `[supervisor] running N/M: /app/test/foo.test.js`
   * We read the path as the authoritative file identity. MSG_READY frames
   * can arrive any time the CLI sends CMD_HELLO, so they're not reliable
   * boot signals; the supervisor announce is. */
  const SUPERVISOR_ANNOUNCE_RE = /^\[supervisor\] running \d+\/\d+: (.+?\.(?:js|bjs))$/

  /** Match a device path like `/app/test/foo.test.js` back to its testFiles
   * index. The device path has a `<rootDir>/` prefix that the CLI's absolute
   * testFiles don't share, so we match by longest-path-suffix first, then
   * fall back to a basename match ONLY if it's unambiguous — two test files
   * sharing a basename must not silently collapse to one index. */
  function matchDevicePathToIndex(devicePath: string): number {
    // Strip one leading path component (the rootDir) from the device path,
    // so `/app/test/foo.test.js` → `test/foo.test.js`.
    const deviceTail = devicePath.replace(/^\/[^/]+\//, '')
    for (let i = 0; i < testFiles.length; i++) {
      const cliPath = testFiles[i]!.replace(/\.ts$/, '.js')
      if (devicePath.endsWith(cliPath) || cliPath.endsWith(deviceTail)) return i
    }
    // Basename-only fallback — only if exactly one testFile matches, so we
    // never mis-attribute events between e.g. unit/foo.test.ts and
    // integration/foo.test.ts.
    const deviceBase = devicePath.split('/').pop()
    let basenameMatch = -1
    for (let i = 0; i < testFiles.length; i++) {
      const cliBase = testFiles[i]!.replace(/\.ts$/, '.js').split('/').pop()
      if (cliBase === deviceBase) {
        if (basenameMatch >= 0) return -1
        basenameMatch = i
      }
    }
    return basenameMatch
  }

  const initialState: ManifestState = {
    index: 0,
    seenAnyTestForIndex: false,
    graceUsed: false,
    results: testFiles.map(emptyResult),
    done: false,
    doneReason: null,
    /* No initial onFileStart here — we let the firmware supervisor's
     * `[supervisor] running N/M: /app/path` announcement drive it. This
     * keeps a single side-effect path and makes announcements the single
     * source of truth for file identity, which matters when the device
     * crash-reboots and re-runs files out of ordinal sequence. */
    emits: [],
  }

  // Sentinel event injected by the timeout operator so the reducer can
  // close out the current index with a timeout error using the same code
  // path as other terminal transitions.
  const TIMEOUT_EVENT = {type: '__timeout'} as unknown as ReplEvent

  function reduce(prev: ManifestState, event: ReplEvent): ManifestState {
    if (prev.done) return {...prev, emits: []}
    const currentFile = testFiles[prev.index]
    if (!currentFile) return {...prev, done: true, doneReason: 'manifest_done', emits: []}

    if ((event as {type: string}).type === '__timeout') {
      if (!prev.graceUsed) {
        return {
          ...prev,
          graceUsed: true,
          emits: [
            {
              kind: 'log',
              level: 'warn',
              text: `no events for ${timeoutMs}ms — waiting one more window before giving up`,
              file: currentFile,
            },
          ],
        }
      }
      const results = prev.results.slice()
      if (prev.index < testFiles.length && !results[prev.index]?.error) {
        results[prev.index] = {
          ...results[prev.index]!,
          error: `Timeout after ${timeoutMs}ms`,
        }
      }
      return {...prev, results, done: true, doneReason: 'timeout', emits: []}
    }
    // Any real event proves the device is alive — re-arm the grace window.
    if (prev.graceUsed) prev = {...prev, graceUsed: false}

    switch (event.type) {
      case 'ready':
        /* Ignore ready events outright. They can arrive whenever the CLI
         * sends CMD_HELLO (e.g. during awaitReady$ inside a deploy), so
         * they're not reliable boot signals. Real crash detection comes
         * from seeing an earlier supervisor-announce path than the current
         * index (see below). */
        return {...prev, emits: []}
      case 'manifest_done':
        return {...prev, done: true, doneReason: 'manifest_done', emits: []}
      case 'disconnect':
        return {...prev, done: true, doneReason: 'disconnect', emits: []}
      case 'debug': {
        /* Supervisor announcements are the authoritative signal for which
         * file the device is about to evaluate. Use them to sync the
         * CLI's index to whatever the device is actually running — this
         * handles out-of-order execution, skipped files, and (critically)
         * crash-reboot loops where the device restarts mid-manifest and
         * re-runs files from 1. */
        const match = SUPERVISOR_ANNOUNCE_RE.exec(event.text)
        if (match) {
          const devicePath = match[1]!
          const targetIndex = matchDevicePathToIndex(devicePath)
          if (targetIndex >= 0) {
            if (targetIndex < prev.index && prev.seenAnyTestForIndex) {
              /* Device jumped back — it crashed and restarted. Bail with
               * what we have; the partial results of the current file are
               * meaningless now, and re-running earlier files would
               * overwrite already-closed results. */
              const results = prev.results.slice()
              if (!results[prev.index]?.error) {
                results[prev.index] = {
                  ...results[prev.index]!,
                  error: 'Device restarted unexpectedly during test run',
                }
              }
              return {
                ...prev,
                results,
                done: true,
                doneReason: 'crash',
                emits: [{kind: 'log', level: 'error', text: event.text, file: currentFile}],
              }
            }
            if (targetIndex !== prev.index) {
              /* Forward jump: the supervisor skipped over some files (or
               * we missed their e:6 events — e.g. a file that died at
               * load without reporting). Close every skipped index as
               * errored so it can't sit in the totals as a silent zero,
               * then start the new file. */
              const results = prev.results.slice()
              const emits: Emit[] = []
              for (let i = prev.index; i < targetIndex; i++) {
                const r = results[i]!
                if (!r.completed && !r.error) {
                  results[i] = {...r, error: 'No results received from device'}
                  emits.push({kind: 'file_done', result: results[i]!, index: i, file: r.file})
                }
              }
              emits.push(
                {
                  kind: 'log',
                  level: 'debug',
                  text: event.text,
                  file: testFiles[targetIndex]!,
                },
                {kind: 'file_start', file: testFiles[targetIndex]!, index: targetIndex},
              )
              return {
                ...prev,
                results,
                index: targetIndex,
                seenAnyTestForIndex: false,
                emits,
              }
            }
            /* Same index. If we haven't seen any test events for it yet,
             * this is the expected "announce for the file e:6 just advanced
             * us to" — fire onFileStart now. Otherwise a re-announce (e.g.
             * device re-running the same file for some reason) is just a
             * log line. */
            if (!prev.seenAnyTestForIndex) {
              return {
                ...prev,
                emits: [
                  {kind: 'log', level: 'debug', text: event.text, file: currentFile},
                  {kind: 'file_start', file: currentFile, index: prev.index},
                ],
              }
            }
          }
        }
        return {
          ...prev,
          emits: [{kind: 'log', level: 'debug', text: event.text, file: currentFile}],
        }
      }
      case 'log':
      case 'warn':
      case 'error':
      case 'info':
        return {
          ...prev,
          emits: [{kind: 'log', level: event.type, text: event.text, file: currentFile}],
        }
      case 'raw':
        /* Raw bytes are non-TLV output from the device (boot banner, panic
         * traces). They aren't attributable to a specific test file, so the
         * test command's top-level session.messages$ subscription forwards
         * them directly. Silently pass through here. */
        return {...prev, emits: []}
      case 'eval_error': {
        const results = prev.results.slice()
        results[prev.index] = {
          ...results[prev.index]!,
          error: `Fatal error: ${event.text}`,
        }
        return {
          ...prev,
          results,
          emits: [{kind: 'log', level: 'error', text: event.text, file: currentFile}],
        }
      }
      case 'test':
        return reduceTestEvent(prev, event, currentFile)
      default:
        return {...prev, emits: []}
    }
  }

  function reduceTestEvent(
    prev: ManifestState,
    event: TestEvent,
    currentFile: string,
  ): ManifestState {
    const d = event.data
    const e = d.e
    const results = prev.results.slice()
    const result: TestFileResult = {
      ...results[prev.index]!,
      events: [...results[prev.index]!.events, event],
    }

    if (e === 2) result.passed++
    else if (e === 3) result.failed++
    else if (e === 4) result.skipped++
    else if (e === 9) result.todo++
    else if (e === 5 && typeof d.hr === 'number') {
      result.suites = [
        ...(result.suites ?? []),
        {
          name: d.s as string,
          retained: d.hr as number,
          ...(typeof d.su === 'number' ? {sysUsed: d.su as number} : {}),
        },
      ]
    }

    const emits: Emit[] = [{kind: 'event', event, file: currentFile}]

    if (e === 6) {
      result.completed = true
      result.passed = (d.p as number) ?? result.passed
      result.failed = (d.f as number) ?? result.failed
      result.skipped = (d.k as number) ?? result.skipped
      result.todo = (d.o as number) ?? result.todo
      result.duration = (d.d as number) ?? 0
      // `hr` sums each suite's retention against its own baseline. Firmware
      // predating it reports only the endpoints, where a file with more than
      // one beforeAll measures just the last suite.
      if (typeof d.hr === 'number') {
        result.heapDelta = d.hr as number
      } else if (typeof d.hb === 'number' && typeof d.ha === 'number') {
        result.heapDelta = (d.ha as number) - (d.hb as number)
      }
      if (typeof d.su === 'number') result.sysUsed = d.su as number
      if (typeof d.sf === 'number') result.sysMinFree = d.sf as number
      if (typeof d.tb === 'number' && typeof d.ta === 'number') {
        result.timerDelta = (d.ta as number) - (d.tb as number)
      }
      if (typeof d.pb === 'number' && typeof d.pa === 'number') {
        result.pendingDelta = (d.pa as number) - (d.pb as number)
      }
      emits.push({kind: 'file_done', result, index: prev.index, file: currentFile})

      const nextIndex = prev.index + 1
      results[prev.index] = result

      if (nextIndex < testFiles.length) {
        /* Don't preemptively fire onFileStart here — the next supervisor
         * announcement will drive that. If the device crashes and
         * restarts, the expected "next" file is wrong anyway. */
        return {...prev, results, index: nextIndex, seenAnyTestForIndex: false, emits}
      }
      // Ran out of declared files — natural end of manifest.
      return {
        ...prev,
        results,
        index: nextIndex,
        seenAnyTestForIndex: false,
        done: true,
        doneReason: 'manifest_done',
        emits,
      }
    }

    results[prev.index] = result
    return {...prev, results, seenAnyTestForIndex: true, emits}
  }

  /* Indices that already produced an onFileDone callback, so the
   * finalization pass below doesn't double-report them. */
  const reportedDone = new Set<number>()

  function applyEmits(state: ManifestState): void {
    for (const e of state.emits) {
      if (e.kind === 'file_start') cb.onFileStart?.(e.file, e.index, testFiles.length)
      else if (e.kind === 'file_done') {
        reportedDone.add(e.index)
        cb.onFileDone?.(e.result, e.index, testFiles.length)
      } else if (e.kind === 'event') cb.onEvent?.(e.event, e.file)
      else if (e.kind === 'log') cb.onLog?.(e.level, e.text, e.file)
    }
  }

  // Inactivity timer: if no event arrives for `timeoutMs`, inject a
  // synthetic timeout event so the reducer can apply its grace logic.
  // Deliberately NOT rxjs `timeout({each, with})` — that operator switches
  // away from (unsubscribes) the source when it fires, so the run could
  // never resume after a grace warning. A merged self-re-arming timer
  // keeps the device stream alive across silent windows; consecutive
  // fires with no real event in between let the reducer detect a dead
  // device. Good-enough proxy for per-file: test.ts emits heap events
  // around each test, so an actively-running file keeps re-arming this.
  const sentinel$ = new Subject<ReplEvent>()
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => {
      sentinel$.next(TIMEOUT_EVENT)
      arm()
    }, timeoutMs)
  }
  arm()

  const final = await lastValueFrom(
    merge(session.messages$.pipe(tap(() => arm())), sentinel$).pipe(
      finalize(() => {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer)
      }),
      // Raw-event diagnostic: logs every event before any filtering, so
      // we can tell whether session.messages$ is emitting at all or the
      // issue is further up the pipeline. No-op unless MIKRO_DEBUG_EVENTS=1.
      tap((event) => {
        if (debug) {
          // eslint-disable-next-line no-console
          console.error(`[raw-ev] ${event.type}`)
        }
      }),
      scan<ReplEvent, ManifestState>(reduce, initialState),
      tap((state) => {
        if (debug) {
          // eslint-disable-next-line no-console
          console.error(
            `[dbg] idx=${state.index} done=${state.done}${
              state.doneReason ? `(${state.doneReason})` : ''
            } emits=${state.emits.length}`,
          )
        }
        applyEmits(state)
      }),
      takeWhile((state) => !state.done, true),
      last(),
      catchError((err) => {
        // Any unexpected stream error ends the run with a diagnostic on
        // file 0 rather than a silent reject.
        const results = testFiles.map(emptyResult)
        results[0]!.error = `Unexpected stream error: ${String(err)}`
        return of({
          index: 0,
          seenAnyTestForIndex: false,
          graceUsed: false,
          results,
          done: true,
          doneReason: null as ManifestState['doneReason'],
          emits: [],
        } satisfies ManifestState)
      }),
    ),
  )

  /* Integrity pass: a result with neither a run_done nor an error means
   * the file was never accounted — the run ended (crash, timeout,
   * disconnect, or early manifest_done) before it ran. Mark it errored so
   * the summary can't report PASS over it, and report any errored file
   * that never reached onFileDone so it appears in per-file output too. */
  const results = final.results.map((r) =>
    r.completed || r.error ? r : {...r, error: 'No results received from device'},
  )
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    if (r.error && !reportedDone.has(i)) {
      cb.onFileDone?.(r, i, testFiles.length)
    }
  }
  return results
}
