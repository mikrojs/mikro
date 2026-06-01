import * as pathlib from 'node:path'

import {command, constant, message, multiple, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'

import {agentEmit, agentResult, isAgentMode} from '../lib/agent.js'
import {loadEnvFiles, validateNvsKeys} from '../lib/deploy.js'
import {formatDeployEvent} from '../lib/deployProgress.js'
import {parseMinifier, parseMinifyLevel} from '../lib/parseMinifier.js'
import {port} from '../lib/portValueParser.js'
import {getMikroDir, resolveProjectRoot} from '../lib/projectRoot.js'
import {openSession} from '../lib/serial/openSession.js'
import type {TestEvent} from '../lib/session.js'
import {
  discoverTestFiles,
  formatBytes,
  formatMemorySummary,
  runTestManifest,
  type TestFileResult,
  type TestRunOptions,
} from '../lib/testRunner.js'

export const args = command(
  'test',
  object({
    action: constant('test'),
    filters: multiple(
      argument(string({metavar: 'PATH_OR_PATTERN'}), {
        description: message`Test file paths and/or glob patterns. Pass one or more. Default: **/*.test.ts`,
      }),
    ),
    port: optional(
      option('-p', '--port', port(), {
        description: message`Serial port of device`,
      }),
    ),
    env: optional(
      option('--env-file', path({metavar: 'FILE', type: 'file', mustExist: true}), {
        description: message`Path to .env file`,
      }),
    ),
    noAutoEnv: optional(
      flag('--no-auto-env', {
        description: message`Skip auto-loading of .env and .env.test from the project root`,
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
    updateHeapBaselines: optional(
      flag('--update-heap-baselines', {
        description: message`Overwrite per-file heap-baseline snapshots (<name>.test.heap-baseline.json) with the current run's heapDelta, keyed by the current chip.`,
      }),
    ),
    yes: optional(flag('-y', '--yes', {description: message`Skip confirmation prompt`})),
    diagnostics: optional(
      flag('--diagnostics', {
        description: message`Show per-test heap progress and other runtime diagnostics`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`NDJSON agent mode`})),
  }),
)

// ── Colors ──────────────────────────────────────────────────────────

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

// ── Run ─────────────────────────────────────────────────────────────

export async function run(config: InferValue<typeof args>): Promise<void> {
  const jsonOutput = config.json === true || isAgentMode(config.agent)
  // eslint-disable-next-line no-console
  const log = jsonOutput ? () => {} : (msg: string) => console.error(msg)

  const cwd = process.cwd()
  let testFiles: string[] = []
  try {
    testFiles = await discoverTestFiles(cwd, config.filters)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (jsonOutput) agentResult('test', {error: msg})
    else log(msg)
    process.exit(1)
  }

  if (testFiles.length === 0) {
    if (jsonOutput) {
      agentResult('test', {error: 'No test files found'})
    } else {
      log('No *.test.ts files found')
    }
    process.exit(1)
  }

  log(`Found ${testFiles.length} test file(s)`)

  // Confirm before overwriting device app
  if (!config.yes && !jsonOutput && process.stdin.isTTY) {
    const {createInterface} = await import('node:readline')
    const rl = createInterface({input: process.stdin, output: process.stderr})
    const answer = await new Promise<string>((resolve) => {
      rl.question('This will overwrite the app on the device. Continue? (y/N) ', resolve)
    })
    rl.close()
    if (answer.toLowerCase() !== 'y') {
      process.exit(0)
    }
  }

  // Connect to device
  const handles = await openSession({
    port: config.port,
    onConnecting: (path) => log(`Connecting to ${path}`),
  })
  const {session} = handles

  // Forward any non-TLV bytes from the device (boot banner, panic traces)
  // straight to stderr so a crash-looping or otherwise misbehaving device
  // is visible to the user instead of silently timing out the test run.
  // This also activates the shared messages$ pipeline; collectManifestEvents
  // piggybacks on the same hot observable.
  const sub = session.messages$.subscribe((event) => {
    if (event.type === 'raw' && !jsonOutput) {
      log(dim(event.text))
    } else if (event.type === 'raw' && jsonOutput) {
      agentEmit({type: 'log', level: 'raw', text: event.text})
    }
  })

  const envVars = await loadEnvFiles({
    cwd: resolveProjectRoot(),
    mode: 'test',
    envFile: config.env,
    noAutoEnv: config.noAutoEnv === true,
  })
  validateNvsKeys(envVars)
  if (envVars.length > 0) {
    log(`Loaded ${envVars.length} env var(s) from file`)
  }
  const timeoutMs = config.timeout ? parseInt(config.timeout, 10) : 60_000

  const options: TestRunOptions = {
    minify: !config.noMinify,
    bytecode: !config.noBytecode,
    minifier: parseMinifier(config.minifier),
    minifyLevel: parseMinifyLevel(config.minifyLevel),
    envVars,
    timeout: timeoutMs,
    buildDir: pathlib.join(getMikroDir(), 'build'),
    mikroEnv: 'test',
    updateHeapBaselines: config.updateHeapBaselines === true,
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
            ...(result.heapBaselineAction ? {heapBaselineAction: result.heapBaselineAction} : {}),
            ...(typeof result.heapBaselineStored === 'number'
              ? {heapBaselineStored: result.heapBaselineStored}
              : {}),
            ...(result.error ? {error: result.error} : {}),
          })
        } else {
          renderFileSummary(result, relPath)
          renderLeakReport(result)
        }
      },
      onEvent: (event) => {
        if (!jsonOutput) renderTestEvent(event, config.diagnostics === true)
      },
      onDeployEvent: (event) => {
        if (jsonOutput) {
          if (event.type === 'uploading' || event.type === 'checking') {
            agentEmit({
              type: `deploy_${event.type}`,
              file: event.file,
              index: event.index,
              total: event.total,
            })
          }
          return
        }
        const msg = formatDeployEvent(event)
        if (msg !== null) log(dim(`  ${msg}`))
      },
      onLog: (level, text, file) => {
        const relPath = pathlib.relative(cwd, file)
        if (jsonOutput) {
          agentEmit({type: 'log', file: relPath, level, text})
          return
        }
        // Supervisor announcements and other 'debug'-level events are
        // internal plumbing noise by default; only surface them when the
        // user asked for diagnostics.
        if (level === 'debug' && config.diagnostics !== true) return
        const color = level === 'error' ? red : level === 'warn' ? yellow : dim
        log(`      ${color(text)}`)
      },
      log: jsonOutput ? undefined : (msg) => log(dim(msg)),
    })
  } finally {
    sub.unsubscribe()
    handles.close()
  }

  // Aggregate
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
    agentResult('test', {
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
        heapBaselineAction: r.heapBaselineAction,
        heapBaselineStored: r.heapBaselineStored,
      })),
    })
  } else {
    renderAlertSummary(results, cwd)
    renderAggregate(totals, results.length, Date.now() - startTime)
  }

  process.exit(totals.failed > 0 ? 1 : 0)
}

// ── Rendering ───────────────────────────────────────────────────────

function renderTestEvent(event: TestEvent, diagnostics: boolean): void {
  const d = event.data
  switch (d.e) {
    case 1: // suite_start
      // eslint-disable-next-line no-console
      console.error(`  ${d.s}`)
      break
    case 2: // test_pass
      // eslint-disable-next-line no-console
      console.error(`    ${green('✓')} ${dim(String(d.t))} ${dim(`(${d.d}ms)`)}`)
      break
    case 3: // test_fail
      // eslint-disable-next-line no-console
      console.error(`    ${red('✗')} ${String(d.t)} ${dim(`(${d.d}ms)`)}`)
      // eslint-disable-next-line no-console
      console.error(`      ${red(String(d.m))}`)
      break
    case 4: // test_skip
      // eslint-disable-next-line no-console
      console.error(`    ${yellow('-')} ${dim(String(d.t))}`)
      break
    case 9: // test_todo
      // eslint-disable-next-line no-console
      console.error(`    ${blue('□')} ${dim(String(d.t))}`)
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
      // eslint-disable-next-line no-console
      console.error(dim(`  [${parts.join(', ')}]`))
      break
    }
  }
}

function renderLeakReport(result: TestFileResult): void {
  const chip = result.chip ?? 'unknown'
  switch (result.heapBaselineAction) {
    case 'created':
      // eslint-disable-next-line no-console
      console.error(
        `  ${dim(`wrote heap-baseline for ${chip}: ${formatBytes(result.heapBaselineStored ?? 0)}`)}`,
      )
      break
    case 'updated':
      // eslint-disable-next-line no-console
      console.error(
        `  ${dim(`updated heap-baseline for ${chip}: ${formatBytes(result.heapBaselineStored ?? 0)}`)}`,
      )
      break
    case 'exceeded': {
      const over = (result.heapDelta ?? 0) - (result.heapBaselineStored ?? 0)
      // eslint-disable-next-line no-console
      console.error(
        `  ${yellow(`⚠ heap-baseline exceeded for ${chip}: +${formatBytes(over)} over ${formatBytes(result.heapBaselineStored ?? 0)}. Re-run with --update-heap-baselines to accept.`)}`,
      )
      break
    }
    case 'stale': {
      const under = (result.heapBaselineStored ?? 0) - (result.heapDelta ?? 0)
      // eslint-disable-next-line no-console
      console.error(
        `  ${dim(`heap-baseline stale for ${chip}: now ${formatBytes(result.heapDelta ?? 0)} (stored ${formatBytes(result.heapBaselineStored ?? 0)}, -${formatBytes(under)}). Re-run with --update-heap-baselines to tighten.`)}`,
      )
      break
    }
    case 'ok':
    default:
      break
  }
  if ((result.timerDelta ?? 0) > 0) {
    const n = result.timerDelta!
    // eslint-disable-next-line no-console
    console.error(`  ${yellow(`⚠ ${n} leaked timer${n === 1 ? '' : 's'}`)}`)
  }
  if ((result.pendingDelta ?? 0) > 0) {
    const n = result.pendingDelta!
    // eslint-disable-next-line no-console
    console.error(`  ${yellow(`⚠ ${n} in-flight HTTP request${n === 1 ? '' : 's'} at teardown`)}`)
  }
}

function renderFileSummary(result: TestFileResult, _relPath: string): void {
  if (result.error) {
    // eslint-disable-next-line no-console
    console.error(`  ${red('ERROR')}: ${result.error}`)
    return
  }
  const parts: string[] = []
  if (result.passed > 0) parts.push(green(`${result.passed} passed`))
  if (result.failed > 0) parts.push(red(`${result.failed} failed`))
  if (result.skipped > 0) parts.push(yellow(`${result.skipped} skipped`))
  if (result.todo > 0) parts.push(blue(`${result.todo} todo`))
  const meta = [`${result.duration}ms`, ...formatMemorySummary(result)]
  // eslint-disable-next-line no-console
  console.error(`  ${parts.join(', ')} ${dim(`(${meta.join(', ')})`)}`)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function renderAlertSummary(results: TestFileResult[], cwd: string): void {
  const exceeded = results.filter((r) => r.heapBaselineAction === 'exceeded')
  const stale = results.filter((r) => r.heapBaselineAction === 'stale')
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
  // eslint-disable-next-line no-console
  console.error(`\n${bold('Alerts:')}`)
  if (exceeded.length > 0) {
    const items = exceeded
      .map(
        (r) => `${rel(r.file)} (+${formatBytes((r.heapDelta ?? 0) - (r.heapBaselineStored ?? 0))})`,
      )
      .join(', ')
    // eslint-disable-next-line no-console
    console.error(`  ${yellow(`⚠ heap exceeded: ${items}`)}`)
    // eslint-disable-next-line no-console
    console.error(`    ${dim('Re-run with --update-heap-baselines to accept.')}`)
  }
  if (stale.length > 0) {
    const items = stale
      .map(
        (r) => `${rel(r.file)} (-${formatBytes((r.heapBaselineStored ?? 0) - (r.heapDelta ?? 0))})`,
      )
      .join(', ')
    // eslint-disable-next-line no-console
    console.error(`  ${dim(`heap stale: ${items}`)}`)
  }
  if (timerLeaks.length > 0) {
    const items = timerLeaks.map((r) => `${rel(r.file)} (${r.timerDelta})`).join(', ')
    // eslint-disable-next-line no-console
    console.error(`  ${yellow(`⚠ leaked timers: ${items}`)}`)
  }
  if (httpLeaks.length > 0) {
    const items = httpLeaks.map((r) => `${rel(r.file)} (${r.pendingDelta})`).join(', ')
    // eslint-disable-next-line no-console
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

  // eslint-disable-next-line no-console
  console.error(
    `\n${status} ${parts.join(', ')} (${total} tests across ${fileCount} files) ${dim(formatDuration(totalMs))}`,
  )
}

// No interactive Ink component yet (non-interactive only for now)
export default function _Test() {
  return null
}
