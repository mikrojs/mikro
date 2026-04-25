import {existsSync, readFileSync, statSync} from 'node:fs'
import {glob} from 'node:fs/promises'
import * as pathlib from 'node:path'

import {
  catchError,
  firstValueFrom,
  last,
  lastValueFrom,
  of,
  scan,
  takeWhile,
  tap,
  timeout,
} from 'rxjs'

import type {Minifier, MinifyLevel} from '../../_exports/index.js'
import {buildTests} from './build.js'
import {collectFiles, type EnvVar} from './deploy.js'
import {readBaseline, writeBaseline} from './heapBaseline.js'
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
        const dir = pathlib.dirname(rel)
        if (dir && dir !== '.') return dir
      }
    } catch {
      // Fall through to default
    }
  }
  return 'app'
}

export type HeapBaselineAction = 'created' | 'ok' | 'exceeded' | 'updated' | 'stale'

export interface TestFileResult {
  file: string
  passed: number
  failed: number
  skipped: number
  todo: number
  duration: number
  events: TestEvent[]
  error?: string
  /** heapUsed delta (bytes) between run start and end, after gc on both sides */
  heapDelta?: number
  /** Net timer count change between run start and end (should be 0) */
  timerDelta?: number
  /** Net in-flight HTTP request count change (should be 0). Detects fetches
   *  that were initiated but not cancelled or awaited before teardown. */
  pendingDelta?: number
  /** Chip reported by the device (e.g. "esp32c6", "host"). Used as baseline key. */
  chip?: string
  /** Stored baseline value for this chip (if a baseline file existed) */
  heapBaselineStored?: number
  /** What happened to the heap-baseline file this run */
  heapBaselineAction?: HeapBaselineAction
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
  /** If true, write the current heapDelta as the new baseline for the current chip. */
  updateHeapBaselines?: boolean
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
  /** Generic progress messages. */
  log?: (msg: string) => void
}

/**
 * Build the test manifest, deploy once, and observe the device supervisor
 * stream as each test file runs in its own fresh runtime. Returns one
 * TestFileResult per input, with heap-baseline bookkeeping applied.
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

  // Resolve chip before streaming so heap-baseline bookkeeping can run
  // synchronously inside onFileDone — otherwise the per-file render happens
  // before heapBaselineAction is set and the user sees no feedback.
  // ready$ is shareReplay(1) and session.deploy() awaits ready, so this is
  // cached and resolves immediately.
  const ready = await firstValueFrom(session.ready$)
  const chip = ready.chip ?? 'unknown'

  const wrappedCb: TestManifestCallbacks = {
    ...cb,
    onFileDone: (result, index, total) => {
      applyHeapBaseline(result, chip, options.updateHeapBaselines ?? false)
      cb.onFileDone?.(result, index, total)
    },
  }

  cb.log?.('Waiting for test results...')
  return await collectManifestEvents(session, testFiles, options.timeout, wrappedCb)
}

/**
 * Mutates `result` with chip + heap-baseline bookkeeping fields and writes
 * the baseline file when appropriate. Must run before the user-visible
 * render of a TestFileResult so messages like "heap-baseline exceeded" can
 * appear alongside the file's pass/fail summary.
 */
function applyHeapBaseline(result: TestFileResult, chip: string, update: boolean): void {
  result.chip = chip
  if (typeof result.heapDelta !== 'number') return
  const stored = readBaseline(result.file, chip)
  if (update) {
    writeBaseline(result.file, chip, result.heapDelta)
    result.heapBaselineAction = stored === undefined ? 'created' : 'updated'
    result.heapBaselineStored = result.heapDelta
    return
  }
  if (stored === undefined) {
    writeBaseline(result.file, chip, result.heapDelta)
    result.heapBaselineAction = 'created'
    result.heapBaselineStored = result.heapDelta
    return
  }
  result.heapBaselineStored = stored
  if (result.heapDelta > stored) {
    result.heapBaselineAction = 'exceeded'
    return
  }
  // Nudge to tighten the snapshot when actual is well below stored, so
  // optimizations get locked in rather than leaving slack that masks a
  // future regression. Margin: max(512B, 25% of stored).
  const margin = Math.max(512, Math.floor(stored * 0.25))
  result.heapBaselineAction = result.heapDelta < stored - margin ? 'stale' : 'ok'
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
      const results = prev.results.slice()
      if (prev.index < testFiles.length && !results[prev.index]?.error) {
        results[prev.index] = {
          ...results[prev.index]!,
          error: `Timeout after ${timeoutMs}ms`,
        }
      }
      return {...prev, results, done: true, doneReason: 'timeout', emits: []}
    }

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
               * we missed their e:6 events). Start the new file. */
              return {
                ...prev,
                index: targetIndex,
                seenAnyTestForIndex: false,
                emits: [
                  {
                    kind: 'log',
                    level: 'debug',
                    text: event.text,
                    file: testFiles[targetIndex]!,
                  },
                  {kind: 'file_start', file: testFiles[targetIndex]!, index: targetIndex},
                ],
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

    const emits: Emit[] = [{kind: 'event', event, file: currentFile}]

    if (e === 6) {
      result.passed = (d.p as number) ?? result.passed
      result.failed = (d.f as number) ?? result.failed
      result.skipped = (d.k as number) ?? result.skipped
      result.todo = (d.o as number) ?? result.todo
      result.duration = (d.d as number) ?? 0
      if (typeof d.hb === 'number' && typeof d.ha === 'number') {
        result.heapDelta = (d.ha as number) - (d.hb as number)
      }
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

  function applyEmits(state: ManifestState): void {
    for (const e of state.emits) {
      if (e.kind === 'file_start') cb.onFileStart?.(e.file, e.index, testFiles.length)
      else if (e.kind === 'file_done') cb.onFileDone?.(e.result, e.index, testFiles.length)
      else if (e.kind === 'event') cb.onEvent?.(e.event, e.file)
      else if (e.kind === 'log') cb.onLog?.(e.level, e.text, e.file)
    }
  }

  const final = await lastValueFrom(
    session.messages$.pipe(
      // Raw-event diagnostic: logs every event before any filtering, so
      // we can tell whether session.messages$ is emitting at all or the
      // issue is further up the pipeline. No-op unless MIKRO_DEBUG_EVENTS=1.
      tap((event) => {
        if (debug) {
          // eslint-disable-next-line no-console
          console.error(`[raw-ev] ${event.type}`)
        }
      }),
      // Per-emission timeout: if no event arrives for `timeoutMs`, inject
      // a synthetic timeout event so the reducer can close out the current
      // index with a real error message. Good-enough proxy for per-file:
      // test.ts emits heap events around each test, so an actively-running
      // file keeps ticking this timer; a hung/crashed device stops
      // emitting and trips it.
      timeout({each: timeoutMs, with: () => of(TIMEOUT_EVENT)}),
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
          results,
          done: true,
          doneReason: null as ManifestState['doneReason'],
          emits: [],
        } satisfies ManifestState)
      }),
    ),
  )

  return final.results
}
