/**
 * Contract tests for collectManifestEvents, the reducer that turns the
 * firmware supervisor's event stream into one TestFileResult per test file.
 *
 * The device supervisor emits:
 *   - `[supervisor] running N/M: /app/path.js` (MSG_DEBUG) before each file
 *   - test events (MSG_TEST) during the file
 *   - `e:6` run_done at the end of each file
 *   - MSG_MANIFEST_DONE after the last file
 *
 * The CLI reducer treats the supervisor announcement as the single source
 * of truth for file identity. This matters because:
 *   - Each test file's per-file serve loop calls MIK_ProtocolOpen, which
 *     means a CMD_HELLO during a manifest run can yield extra MSG_READY
 *     frames that aren't crash signals.
 *   - The device may crash-reboot mid-manifest and re-run files; the CLI
 *     needs to detect the backward jump and bail cleanly.
 *   - Ordinal counting breaks as soon as any e:6 is missed or any file
 *     runs out of order.
 */
import {firstValueFrom, Subject} from 'rxjs'
import {describe, expect, it, vi} from 'vitest'

import type {ReadyEvent, ReplEvent, ReplSession, TestEvent} from '../session.js'
import {collectManifestEvents, type TestManifestCallbacks} from '../testRunner.js'

// ── Mock session ────────────────────────────────────────────────────

function mockSession(): {session: ReplSession; emit: (event: ReplEvent) => void} {
  const messages$ = new Subject<ReplEvent>()
  const session = {
    messages$: messages$.asObservable(),
    ready$: new Subject<ReadyEvent>().asObservable(),
    awaitReady$: () => new Subject<ReadyEvent>().asObservable(),
    eval() {},
    directive() {},
    complete() {},
    exit() {},
    deploy() {
      throw new Error('not used')
    },
    eraseApp: async () => {},
    config: {list: async () => [], set: async () => {}, delete: async () => {}},
    restart() {},
    close() {},
  } as unknown as ReplSession
  return {session, emit: (event) => messages$.next(event)}
}

// ── Event builders ──────────────────────────────────────────────────

const announce = (idx: number, total: number, path: string): ReplEvent => ({
  type: 'debug',
  text: `[supervisor] running ${idx}/${total}: ${path}`,
})

const testEvent = (data: Record<string, unknown>): TestEvent => ({type: 'test', data})

const runDone = (p = 1, f = 0, k = 0, o = 0, d = 10): TestEvent => testEvent({e: 6, p, f, k, o, d})

const testPass = (suite: string, name: string): TestEvent =>
  testEvent({e: 2, s: suite, t: name, d: 1})

const manifestDone = (): ReplEvent => ({type: 'manifest_done'})

// ── Callback recorder ───────────────────────────────────────────────

interface Recorded {
  starts: {file: string; index: number}[]
  dones: {file: string; index: number; passed: number; failed: number; error?: string}[]
  events: {file: string; eCode: number}[]
}

function recorder(): {cb: TestManifestCallbacks; rec: Recorded} {
  const rec: Recorded = {starts: [], dones: [], events: []}
  const cb: TestManifestCallbacks = {
    onFileStart: (file, index) => rec.starts.push({file, index}),
    onFileDone: (result, index) =>
      rec.dones.push({
        file: result.file,
        index,
        passed: result.passed,
        failed: result.failed,
        error: result.error,
      }),
    onEvent: (event, file) => rec.events.push({file, eCode: (event.data as {e: number}).e}),
  }
  return {cb, rec}
}

// ── Tests ────────────────────────────────────────────────────────────

describe('collectManifestEvents', () => {
  const TIMEOUT = 60_000

  const testFiles = ['/cwd/test/a.test.ts', '/cwd/test/b.test.ts', '/cwd/test/c.test.ts']
  const devicePaths = ['/app/test/a.test.js', '/app/test/b.test.js', '/app/test/c.test.js']

  it('normal flow: announcement drives index, e:6 closes file, manifest_done ends run', async () => {
    const {session, emit} = mockSession()
    const {cb, rec} = recorder()

    const promise = collectManifestEvents(session, testFiles, TIMEOUT, cb)
    // Yield once so the subscription is active before we emit.
    await Promise.resolve()

    for (let i = 0; i < testFiles.length; i++) {
      emit(announce(i + 1, testFiles.length, devicePaths[i]!))
      emit(testPass('suite', 'test1'))
      emit(runDone(1, 0, 0, 0, 42))
    }
    emit(manifestDone())

    const results = await promise

    expect(rec.starts.map((s) => s.index)).toEqual([0, 1, 2])
    expect(rec.dones.map((d) => d.index)).toEqual([0, 1, 2])
    expect(results.map((r) => r.passed)).toEqual([1, 1, 1])
    expect(results.map((r) => r.error)).toEqual([undefined, undefined, undefined])
  })

  it('MSG_READY spam does not false-trigger crash detection', async () => {
    // Defensive: any MSG_READY arriving mid-manifest (e.g. from a stray
    // CMD_HELLO or a future protocol change) must be ignored entirely.
    // Only supervisor announcements can signal state changes.
    const {session, emit} = mockSession()
    const {cb, rec} = recorder()

    const promise = collectManifestEvents(session, testFiles, TIMEOUT, cb)
    await Promise.resolve()

    const ready: ReadyEvent = {type: 'ready', chip: 'esp32c6', id: null, version: null}

    emit(announce(1, 3, devicePaths[0]!))
    for (let i = 0; i < 10; i++) emit(ready)
    emit(testPass('suite', 'test1'))
    for (let i = 0; i < 10; i++) emit(ready)
    emit(runDone())
    emit(announce(2, 3, devicePaths[1]!))
    for (let i = 0; i < 10; i++) emit(ready)
    emit(testPass('suite', 'test1'))
    emit(runDone())
    emit(announce(3, 3, devicePaths[2]!))
    emit(testPass('suite', 'test1'))
    emit(runDone())
    emit(manifestDone())

    const results = await promise
    expect(results.every((r) => r.error === undefined)).toBe(true)
    expect(rec.dones.length).toBe(3)
  })

  it('backward jump in supervisor announcement signals device crash', async () => {
    // When the device panics mid-manifest it reboots and the supervisor
    // restarts from file 1. Without detection, later events would overwrite
    // already-closed earlier results. Detection: an announcement for an
    // earlier index than the current one after we've seen test events.
    const {session, emit} = mockSession()
    const {cb, rec} = recorder()

    const promise = collectManifestEvents(session, testFiles, TIMEOUT, cb)
    await Promise.resolve()

    emit(announce(1, 3, devicePaths[0]!))
    emit(testPass('suite', 'ok'))
    emit(runDone())
    emit(announce(2, 3, devicePaths[1]!))
    emit(testPass('suite', 'in-flight'))
    // Device crashes and reboots — supervisor announces file 1 again.
    emit(announce(1, 3, devicePaths[0]!))

    const results = await promise

    // File 0 completed cleanly with the first run_done.
    expect(results[0]!.passed).toBe(1)
    expect(results[0]!.error).toBeUndefined()
    // File 1 was in flight when the crash happened — annotated with error.
    expect(results[1]!.error).toMatch(/restarted unexpectedly/i)
    // File 2 never started — the finalization pass marks it errored so
    // the summary can't report PASS over a file that never ran.
    expect(results[2]!.passed).toBe(0)
    expect(results[2]!.error).toMatch(/no results/i)
    // Only two onFileStart calls (files 0 and 1). No start for the re-run.
    expect(rec.starts.map((s) => s.index)).toEqual([0, 1])
  })

  it('forward jump fires onFileStart for the target and closes skipped files as errored', async () => {
    // If an e:6 is missed (dropped frame, crash before emit, or a file
    // that died at load without reporting), the next supervisor
    // announcement may skip over an index. The reducer must fire
    // onFileStart for the announced target AND close out the skipped
    // index as errored — a file that produced no results must never
    // count as a silent zero in the totals (the fs.test load-crash bug).
    const {session, emit} = mockSession()
    const {cb, rec} = recorder()

    const promise = collectManifestEvents(session, testFiles, TIMEOUT, cb)
    await Promise.resolve()

    emit(announce(1, 3, devicePaths[0]!))
    emit(testPass('suite', 'ok'))
    emit(runDone())
    // Skip file 1 — jump straight to file 2.
    emit(announce(3, 3, devicePaths[2]!))
    emit(testPass('suite', 'ok'))
    emit(runDone())
    emit(manifestDone())

    const results = await promise

    expect(rec.starts.map((s) => s.index)).toEqual([0, 2])
    expect(rec.dones.map((d) => d.index)).toEqual([0, 1, 2])
    expect(rec.dones.find((d) => d.index === 1)?.error).toMatch(/no results/i)
    expect(results[1]!.error).toMatch(/no results/i)
    expect(results[0]!.error).toBeUndefined()
    expect(results[2]!.error).toBeUndefined()
  })

  it('per-file timeout resets on run_done so each file gets its full budget', async () => {
    // The -t/--timeout flag is documented as "per-file". The reducer
    // implements this by re-arming an internal timer on each advance so
    // a fast file doesn't eat budget that a slow subsequent file needs.
    vi.useFakeTimers()
    try {
      const {session, emit} = mockSession()
      const {cb} = recorder()
      const PER_FILE_TIMEOUT = 1000

      const promise = collectManifestEvents(session, testFiles, PER_FILE_TIMEOUT, cb)
      await Promise.resolve()

      emit(announce(1, 3, devicePaths[0]!))
      emit(testPass('suite', 'quick'))
      // Advance 800ms — less than the per-file budget.
      vi.advanceTimersByTime(800)
      emit(runDone())
      // Advance to next file. The timer must have reset; if it fired at
      // 1000ms wall-clock from subscription, we would already have timed
      // out before any events for file 1 could be received.
      emit(announce(2, 3, devicePaths[1]!))
      // Advance another 800ms — total 1600ms from subscription, but only
      // 800ms since the last run_done.
      vi.advanceTimersByTime(800)
      emit(testPass('suite', 'slow but in budget'))
      emit(runDone())
      emit(announce(3, 3, devicePaths[2]!))
      emit(testPass('suite', 'ok'))
      emit(runDone())
      emit(manifestDone())

      const results = await promise
      expect(results.every((r) => r.error === undefined)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('two silent windows produce a timeout on the in-flight file and account the rest', async () => {
    // One silent window is only a warning (a slow TLS handshake can stall
    // 60s+ without emitting while the file is healthy — seen on esp32c6).
    // A second consecutive silent window means the device is gone: the
    // in-flight file fails with Timeout and every remaining file is
    // closed as errored so the summary cannot report PASS over them.
    vi.useFakeTimers()
    try {
      const {session, emit} = mockSession()
      const {cb} = recorder()
      const PER_FILE_TIMEOUT = 1000

      const promise = collectManifestEvents(session, testFiles, PER_FILE_TIMEOUT, cb)
      await Promise.resolve()

      emit(announce(1, 3, devicePaths[0]!))
      emit(testPass('suite', 'ok'))
      emit(runDone())
      emit(announce(2, 3, devicePaths[1]!))
      emit(testPass('suite', 'started'))
      // Device goes silent through the grace window and beyond.
      await vi.advanceTimersByTimeAsync(2500)

      const results = await promise
      expect(results[0]!.error).toBeUndefined()
      expect(results[1]!.error).toMatch(/Timeout/i)
      expect(results[2]!.error).toMatch(/no results/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a single silent window warns but the run continues when events resume', async () => {
    vi.useFakeTimers()
    try {
      const {session, emit} = mockSession()
      const logs: string[] = []
      const {cb} = recorder()
      cb.onLog = (level, text) => logs.push(`${level}:${text}`)
      const PER_FILE_TIMEOUT = 1000

      const promise = collectManifestEvents(session, testFiles, PER_FILE_TIMEOUT, cb)
      await Promise.resolve()

      emit(announce(1, 3, devicePaths[0]!))
      emit(testPass('suite', 'slow start'))
      // Silent past one window — grace warning, not a failure.
      await vi.advanceTimersByTimeAsync(1500)
      // Device comes back and finishes everything.
      emit(testPass('suite', 'recovered'))
      emit(runDone(2))
      emit(announce(2, 3, devicePaths[1]!))
      emit(testPass('suite', 'ok'))
      emit(runDone())
      emit(announce(3, 3, devicePaths[2]!))
      emit(testPass('suite', 'ok'))
      emit(runDone())
      emit(manifestDone())

      const results = await promise
      expect(results.every((r) => r.error === undefined)).toBe(true)
      expect(logs.some((l) => /no events for/i.test(l))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('two test files sharing a basename are not silently collapsed', async () => {
    // When the user organizes tests by feature (unit/foo.test.ts and
    // integration/foo.test.ts), the basename-only fallback must not
    // attribute events from both files to whichever one is matched first.
    const {session, emit} = mockSession()
    const {cb, rec} = recorder()

    const ambigFiles = ['/cwd/unit/foo.test.ts', '/cwd/integration/foo.test.ts']
    const ambigDevice = ['/app/unit/foo.test.js', '/app/integration/foo.test.js']

    const promise = collectManifestEvents(session, ambigFiles, TIMEOUT, cb)
    await Promise.resolve()

    emit(announce(1, 2, ambigDevice[0]!))
    emit(testPass('suite', 'first'))
    emit(runDone(1))
    emit(announce(2, 2, ambigDevice[1]!))
    emit(testPass('suite', 'second'))
    emit(runDone(1))
    emit(manifestDone())

    await promise

    expect(rec.starts.map((s) => s.index)).toEqual([0, 1])
    expect(rec.dones.map((d) => d.index)).toEqual([0, 1])
  })

  it('eval_error attaches a fatal error to the in-flight file', async () => {
    const {session, emit} = mockSession()
    const {cb} = recorder()

    const promise = collectManifestEvents(session, testFiles, TIMEOUT, cb)
    await Promise.resolve()

    emit(announce(1, 3, devicePaths[0]!))
    emit({type: 'eval_error', text: 'SyntaxError: unexpected token'})
    // Supervisor continues.
    emit(runDone(0, 1))
    emit(announce(2, 3, devicePaths[1]!))
    emit(testPass('suite', 'ok'))
    emit(runDone())
    emit(announce(3, 3, devicePaths[2]!))
    emit(testPass('suite', 'ok'))
    emit(runDone())
    emit(manifestDone())

    const results = await promise
    expect(results[0]!.error).toMatch(/Fatal error/i)
    expect(results[1]!.error).toBeUndefined()
    expect(results[2]!.error).toBeUndefined()
  })
})

// Ensure firstValueFrom is reachable in the type graph even though we
// don't use it directly — keeps the import from being eslint-pruned if
// the test is extended to exercise ready$.
void firstValueFrom
