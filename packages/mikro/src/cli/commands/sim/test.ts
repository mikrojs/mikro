/* eslint-disable no-console */
import * as pathlib from 'node:path'

import {command, constant, message, multiple, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'

import {agentEmit, agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {loadEnvFiles} from '../../lib/deploy.js'
import {openSim} from '../../lib/openSim.js'
import {parseMinifier, parseMinifyLevel} from '../../lib/parseMinifier.js'
import {parseSize} from '../../lib/parseSize.js'
import {getMikroDir, resolveProjectRoot} from '../../lib/projectRoot.js'
import type {TestEvent} from '../../lib/session.js'
import {SimAlreadyRunningError} from '../../lib/simPid.js'
import {
  discoverTestFiles,
  formatBytes,
  formatMemorySummary,
  runTestManifest,
  type TestFileResult,
  type TestRunOptions,
} from '../../lib/testRunner.js'

export const args = command(
  'test',
  object({
    subcommand: constant('test' as const),
    filters: multiple(
      argument(string({metavar: 'PATH_OR_PATTERN'}), {
        description: message`Test file paths and/or glob patterns. Pass one or more. Default: **/*.test.ts`,
      }),
    ),
    env: optional(option('--env-file', path({metavar: 'FILE', type: 'file', mustExist: true}))),
    noAutoEnv: optional(
      flag('--no-auto-env', {
        description: message`Skip auto-loading of .env and .env.simulator from the project root`,
      }),
    ),
    noMinify: optional(flag('--no-minify', {description: message`Skip minification`})),
    minifier: optional(
      option('--minifier', string({metavar: 'NAME'}), {
        description: message`Minifier: esbuild, terser, or swc (default: esbuild)`,
      }),
    ),
    minifyLevel: optional(
      option('--minify-level', string({metavar: 'LEVEL'}), {
        description: message`Minify level: default or max`,
      }),
    ),
    noBytecode: optional(flag('--no-bytecode', {description: message`Skip bytecode compilation`})),
    timeout: optional(
      option('-t', '--timeout', string({metavar: 'MS'}), {
        description: message`Per-file timeout in ms (default: 60000)`,
      }),
    ),
    updateHeapSnapshots: optional(
      flag('-u', '--update-heap', {
        description: message`Overwrite committed heap snapshots (__heap_snapshots__/<chip>.json) with the current run's heapDelta. Drift under the tolerance is left alone.`,
      }),
    ),
    heapTolerance: optional(
      option('--heap-tolerance', string({metavar: 'SIZE'}), {
        description: message`Heap drift below which a snapshot is neither flagged nor rewritten (default: max(256, 1% of stored)). Accepts a K/M suffix.`,
      }),
    ),
    diagnostics: optional(
      flag('--diagnostics', {
        description: message`Show per-test heap progress and other runtime diagnostics`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`NDJSON agent mode`})),
  }),
  {description: message`Run *.test.ts files in the simulator`},
)

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

interface RunConfig {
  filters?: readonly string[]
  env?: string
  secrets?: string
  noAutoEnv?: boolean
  noMinify?: boolean
  minifier?: string
  minifyLevel?: string
  noBytecode?: boolean
  timeout?: string
  updateHeapSnapshots?: boolean
  heapTolerance?: string
  diagnostics?: boolean
  json?: boolean
  agent?: boolean
}

export async function run(config: RunConfig): Promise<void> {
  const jsonOutput = config.json === true || isAgentMode(config.agent)
  const log = jsonOutput ? () => {} : (msg: string) => console.error(msg)

  const cwd = process.cwd()

  let heapTolerance: number | undefined
  if (config.heapTolerance !== undefined) {
    try {
      heapTolerance = parseSize(config.heapTolerance)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (jsonOutput) agentResult('sim test', {error: msg})
      else log(msg)
      process.exit(1)
    }
  }

  let testFiles: string[] = []
  try {
    testFiles = await discoverTestFiles(cwd, config.filters)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (jsonOutput) agentResult('sim test', {error: msg})
    else log(msg)
    process.exit(1)
  }

  if (testFiles.length === 0) {
    if (jsonOutput) agentResult('sim test', {error: 'No test files found'})
    else log('No *.test.ts files found')
    process.exit(1)
  }

  log(`Found ${testFiles.length} test file(s)`)

  let session
  let transport
  try {
    log('Connecting to simulator')
    const conn = await openSim()
    session = conn.session
    transport = conn.transport
  } catch (err) {
    if (err instanceof SimAlreadyRunningError) {
      if (jsonOutput) {
        agentError('sim test', err.message, {
          fix: 'Stop the running sim (Ctrl-C in that terminal), then retry.',
        })
      } else {
        console.error(`Error: ${err.message}`)
      }
      process.exit(1)
    }
    throw err
  }

  const sub = session.messages$.subscribe()

  const envVars = await loadEnvFiles({
    cwd: resolveProjectRoot(),
    mode: 'simulator',
    envFile: config.env,
    noAutoEnv: config.noAutoEnv === true,
  })
  if (envVars.length > 0) log(`Loaded ${envVars.length} env var(s) from file`)
  const timeoutMs = config.timeout ? parseInt(config.timeout, 10) : 60_000

  const options: TestRunOptions = {
    minify: !config.noMinify,
    bytecode: !config.noBytecode,
    minifier: parseMinifier(config.minifier),
    minifyLevel: parseMinifyLevel(config.minifyLevel),
    envVars,
    timeout: timeoutMs,
    buildDir: pathlib.join(getMikroDir(), 'build'),
    mikroEnv: 'simulator',
    updateHeapSnapshots: config.updateHeapSnapshots === true,
    ...(heapTolerance === undefined ? {} : {heapTolerance}),
  }

  const startTime = Date.now()
  let results: TestFileResult[]

  try {
    results = await runTestManifest(session, testFiles, options, {
      onFileStart: (file, i, total) => {
        const relPath = pathlib.relative(cwd, file)
        if (jsonOutput) {
          agentEmit({type: 'file_start', file: relPath, index: i, total})
        } else {
          log(`\n${bold(`[${i + 1}/${total}]`)} ${relPath}`)
        }
      },
      onFileDone: (result) => {
        const relPath = pathlib.relative(cwd, result.file)
        if (jsonOutput) {
          agentEmit({
            type: 'file_done',
            file: relPath,
            passed: result.passed,
            failed: result.failed,
            skipped: result.skipped,
            todo: result.todo,
            duration: result.duration,
            ...(typeof result.heapDelta === 'number' ? {heapDelta: result.heapDelta} : {}),
            ...(typeof result.sysUsed === 'number' ? {sysUsed: result.sysUsed} : {}),
            ...(typeof result.sysMinFree === 'number' ? {sysMinFree: result.sysMinFree} : {}),
            ...(typeof result.timerDelta === 'number' ? {timerDelta: result.timerDelta} : {}),
            ...(typeof result.pendingDelta === 'number' ? {pendingDelta: result.pendingDelta} : {}),
            ...(result.chip ? {chip: result.chip} : {}),
            ...(result.heapSnapshotAction ? {heapSnapshotAction: result.heapSnapshotAction} : {}),
            ...(typeof result.heapSnapshotStored === 'number'
              ? {heapSnapshotStored: result.heapSnapshotStored}
              : {}),
            ...(typeof result.heapSnapshotPrevious === 'number'
              ? {heapSnapshotPrevious: result.heapSnapshotPrevious}
              : {}),
            ...(result.error ? {error: result.error} : {}),
          })
        } else {
          renderFileSummary(result)
          renderLeakReport(result)
        }
      },
      onEvent: (event) => {
        if (!jsonOutput) renderTestEvent(event, config.diagnostics === true)
      },
      onLog: (level, text, file) => {
        const relPath = pathlib.relative(cwd, file)
        if (jsonOutput) {
          agentEmit({type: 'log', file: relPath, level, text})
          return
        }
        if (level === 'debug' && config.diagnostics !== true) return
        const color = level === 'error' ? red : level === 'warn' ? yellow : dim
        log(`      ${color(text)}`)
      },
      log: jsonOutput ? undefined : (msg) => log(dim(msg)),
    })
  } finally {
    sub.unsubscribe()
    session.close()
    transport.close()
  }

  const totals = results.reduce(
    (acc, r) => ({
      passed: acc.passed + r.passed,
      failed: acc.failed + r.failed,
      skipped: acc.skipped + r.skipped,
      todo: acc.todo + r.todo,
    }),
    {passed: 0, failed: 0, skipped: 0, todo: 0},
  )

  if (jsonOutput) {
    agentResult('sim test', {
      ...totals,
      total: totals.passed + totals.failed + totals.skipped + totals.todo,
      files: results.map((r) => ({
        file: pathlib.relative(cwd, r.file),
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
        todo: r.todo,
        duration: r.duration,
        error: r.error,
        heapDelta: r.heapDelta,
        sysUsed: r.sysUsed,
        sysMinFree: r.sysMinFree,
        timerDelta: r.timerDelta,
        pendingDelta: r.pendingDelta,
        chip: r.chip,
        heapSnapshotAction: r.heapSnapshotAction,
        heapSnapshotStored: r.heapSnapshotStored,
        heapSnapshotPrevious: r.heapSnapshotPrevious,
      })),
    })
  } else {
    renderAlertSummary(results, cwd)
    renderAggregate(totals, results.length, Date.now() - startTime)
  }

  process.exit(totals.failed > 0 ? 1 : 0)
}

function renderTestEvent(event: TestEvent, diagnostics: boolean): void {
  const d = event.data
  switch (d.e) {
    case 1:
      console.error(`  ${d.s}`)
      break
    case 2:
      console.error(`    ${green('✓')} ${dim(String(d.t))} ${dim(`(${d.d}ms)`)}`)
      break
    case 3:
      console.error(`    ${red('✗')} ${String(d.t)} ${dim(`(${d.d}ms)`)}`)
      console.error(`      ${red(String(d.m))}`)
      break
    case 4:
      console.error(`    ${yellow('-')} ${dim(String(d.t))}`)
      break
    case 9:
      console.error(`    ${blue('□')} ${dim(String(d.t))}`)
      break
    case 7: // beforeAll threw; the suite's tests fail with a pointer here
      console.error(`    ${red(`✗ beforeAll failed: ${String(d.m)}`)}`)
      break
    case 8: {
      if (!diagnostics) break
      const used = ((d.u as number) / 1024) | 0
      const total = ((d.t as number) / 1024) | 0
      const free = total - used
      const parts = [`heap: ${used}/${total}KB, free: ${free}KB`]
      if (typeof d.f === 'number') {
        parts.push(`sysFree: ${(d.f / 1024) | 0}KB`)
      }
      if (typeof d.mf === 'number') {
        parts.push(`sysMinFree: ${(d.mf / 1024) | 0}KB`)
      }
      console.error(dim(`  [${parts.join(', ')}]`))
      break
    }
  }
}

/**
 * "updated heap snapshot for simulator: 12.1KB → 11.8KB (-300B)"
 *
 * Retained heap, so down is the win: green for a drop, red for growth. Segments
 * are dimmed individually rather than wrapping the whole line, because the
 * colour reset that ends the delta would otherwise clear the dim as well.
 */
function formatSnapshotUpdate(chip: string, result: TestFileResult): string {
  const before = result.heapSnapshotPrevious ?? 0
  const after = result.heapSnapshotStored ?? 0
  const change = after - before
  const delta = change > 0 ? red(`+${formatBytes(change)}`) : green(formatBytes(change))
  const head = `updated heap snapshot for ${chip}: ${formatBytes(before)} → ${formatBytes(after)} (`
  return `${dim(head)}${delta}${dim(')')}`
}

function renderLeakReport(result: TestFileResult): void {
  const chip = result.chip ?? 'unknown'
  switch (result.heapSnapshotAction) {
    case 'created':
      console.error(
        `  ${dim(`wrote heap snapshot for ${chip}: ${formatBytes(result.heapSnapshotStored ?? 0)}`)}`,
      )
      break
    case 'updated': {
      console.error(`  ${formatSnapshotUpdate(chip, result)}`)
      break
    }
    case 'exceeded': {
      const over = (result.heapDelta ?? 0) - (result.heapSnapshotStored ?? 0)
      console.error(
        `  ${yellow(`⚠ heap snapshot exceeded for ${chip}: +${formatBytes(over)} over ${formatBytes(result.heapSnapshotStored ?? 0)}. Re-run with -u to accept.`)}`,
      )
      break
    }
    case 'stale': {
      const under = (result.heapSnapshotStored ?? 0) - (result.heapDelta ?? 0)
      console.error(
        `  ${dim(`heap snapshot stale for ${chip}: now ${formatBytes(result.heapDelta ?? 0)} (stored ${formatBytes(result.heapSnapshotStored ?? 0)}, -${formatBytes(under)}). Re-run with -u to record it.`)}`,
      )
      break
    }
    case 'skipped':
      console.error(
        `  ${dim(`heap snapshot untouched for ${chip}: ${result.failed > 0 ? 'tests failed' : 'no tests ran'}`)}`,
      )
      break
    case 'ok':
    default:
      break
  }
  if ((result.timerDelta ?? 0) > 0) {
    const n = result.timerDelta!
    console.error(`  ${yellow(`⚠ ${n} leaked timer${n === 1 ? '' : 's'}`)}`)
  }
  if ((result.pendingDelta ?? 0) > 0) {
    const n = result.pendingDelta!
    console.error(`  ${yellow(`⚠ ${n} in-flight HTTP request${n === 1 ? '' : 's'} at teardown`)}`)
  }
}

function renderFileSummary(result: TestFileResult): void {
  if (result.error) {
    console.error(`  ${red('ERROR')}: ${result.error}`)
    return
  }
  const parts: string[] = []
  if (result.passed > 0) parts.push(green(`${result.passed} passed`))
  if (result.failed > 0) parts.push(red(`${result.failed} failed`))
  if (result.skipped > 0) parts.push(yellow(`${result.skipped} skipped`))
  if (result.todo > 0) parts.push(blue(`${result.todo} todo`))
  const meta = [`${result.duration}ms`, ...formatMemorySummary(result)]
  console.error(`  ${parts.join(', ')} ${dim(`(${meta.join(', ')})`)}`)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function renderAlertSummary(results: TestFileResult[], cwd: string): void {
  const exceeded = results.filter((r) => r.heapSnapshotAction === 'exceeded')
  const stale = results.filter((r) => r.heapSnapshotAction === 'stale')
  const timerLeaks = results.filter((r) => (r.timerDelta ?? 0) > 0)
  const httpLeaks = results.filter((r) => (r.pendingDelta ?? 0) > 0)
  if (
    exceeded.length === 0 &&
    stale.length === 0 &&
    timerLeaks.length === 0 &&
    httpLeaks.length === 0
  ) {
    return
  }
  const rel = (f: string) => pathlib.relative(cwd, f)
  console.error(`\n${bold('Alerts:')}`)
  if (exceeded.length > 0) {
    const items = exceeded
      .map(
        (r) => `${rel(r.file)} (+${formatBytes((r.heapDelta ?? 0) - (r.heapSnapshotStored ?? 0))})`,
      )
      .join(', ')
    console.error(`  ${yellow(`⚠ heap exceeded: ${items}`)}`)
    console.error(`    ${dim('Re-run with -u to accept.')}`)
  }
  if (stale.length > 0) {
    const items = stale
      .map(
        (r) => `${rel(r.file)} (-${formatBytes((r.heapSnapshotStored ?? 0) - (r.heapDelta ?? 0))})`,
      )
      .join(', ')
    console.error(`  ${dim(`heap stale: ${items}`)}`)
  }
  if (timerLeaks.length > 0) {
    const items = timerLeaks.map((r) => `${rel(r.file)} (${r.timerDelta})`).join(', ')
    console.error(`  ${yellow(`⚠ leaked timers: ${items}`)}`)
  }
  if (httpLeaks.length > 0) {
    const items = httpLeaks.map((r) => `${rel(r.file)} (${r.pendingDelta})`).join(', ')
    console.error(`  ${yellow(`⚠ in-flight HTTP: ${items}`)}`)
  }
}

function renderAggregate(
  totals: {passed: number; failed: number; skipped: number; todo: number},
  fileCount: number,
  totalMs: number,
): void {
  const total = totals.passed + totals.failed + totals.skipped + totals.todo
  const status = totals.failed === 0 ? green(bold('PASS')) : red(bold('FAIL'))
  const parts: string[] = []
  if (totals.passed > 0) parts.push(green(`${totals.passed} passed`))
  if (totals.failed > 0) parts.push(red(`${totals.failed} failed`))
  if (totals.skipped > 0) parts.push(yellow(`${totals.skipped} skipped`))
  if (totals.todo > 0) parts.push(blue(`${totals.todo} todo`))
  console.error(
    `\n${status} ${parts.join(', ')} (${total} tests across ${fileCount} files) ${dim(formatDuration(totalMs))}`,
  )
}
