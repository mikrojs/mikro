/* eslint-disable no-console */
import {spawn} from 'node:child_process'
import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'
import {fileURLToPath} from 'node:url'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {integer, string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import {lastValueFrom} from 'rxjs'

import {build} from '../../lib/build.js'
import {connectSim} from '../../lib/connectSim.js'
import {collectFiles, loadEnvFiles} from '../../lib/deploy.js'
import {parseMinifier, parseMinifyLevel} from '../../lib/parseMinifier.js'
import {parseSize} from '../../lib/parseSize.js'
import {getMikroDir, resolveProjectRoot} from '../../lib/projectRoot.js'
import {resolveEntry} from '../../lib/resolveEntry.js'
import {loadSimConfig} from '../../lib/simConfig.js'
import {checkPid, SimAlreadyRunningError} from '../../lib/simPid.js'

// Profile mode measures, not enforces. Default to 32 MB so apps larger than
// the device-realistic ceiling can still be profiled. Override with --mem-limit.
const DEFAULT_PROFILE_MEM_LIMIT_BYTES = 32 * 1024 * 1024

export const args = command(
  'profile',
  object({
    subcommand: constant('profile' as const),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
    memLimit: optional(
      option('--mem-limit', string({metavar: 'BYTES'}), {
        description: message`QuickJS heap ceiling for the profile run (default: 32M). Supports K/M/G suffixes.`,
      }),
    ),
    memoryBudget: optional(
      option('--memory-budget', integer({metavar: 'KB'}), {
        description: message`Memory budget in KB for highlighting rows over budget`,
      }),
    ),
    chip: optional(
      option('--chip', string({metavar: 'NAME'}), {
        description: message`Chip preset for --memory-budget (e.g. esp32c6)`,
      }),
    ),
    top: optional(
      option('--top', integer({metavar: 'N'}), {
        description: message`Show only the N largest modules`,
      }),
    ),
    sort: optional(
      option('--sort', string({metavar: 'KEY'}), {
        description: message`Sort by "size" (default) or "order"`,
      }),
    ),
    minBytes: optional(
      option('--min-bytes', integer({metavar: 'N'}), {
        description: message`Hide modules smaller than N bytes`,
      }),
    ),
    includeNative: optional(
      flag('--include-native', {
        description: message`Include native:* runtime modules in the output (excluded by default)`,
      }),
    ),
    includeBuiltins: optional(
      flag('--include-builtins', {
        description: message`Include mikrojs/* built-in modules in the output (excluded by default)`,
      }),
    ),
    onlyNative: optional(
      flag('--only-native', {
        description: message`Show only native:* modules (whitelist; overrides --include-*)`,
      }),
    ),
    onlyBuiltins: optional(
      flag('--only-builtins', {
        description: message`Show only mikrojs/* built-ins (whitelist; overrides --include-*)`,
      }),
    ),
    bundle: optional(
      flag('--bundle', {
        description: message`Enable bundling even if mikro.config.ts disables it`,
      }),
    ),
    noBundle: optional(
      flag('--no-bundle', {
        description: message`Disable bundling even if mikro.config.ts enables it`,
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
    json: optional(flag('--json', {description: message`Output as JSON`})),
    env: optional(
      option('--env-file', path({metavar: 'FILE', type: 'file', mustExist: true}), {
        description: message`Path to .env file with environment variables`,
      }),
    ),
    noAutoEnv: optional(
      flag('--no-auto-env', {
        description: message`Skip auto-loading of .env and .env.development from the project root`,
      }),
    ),
  }),
  {description: message`Profile per-module QuickJS heap usage in the simulator`},
)

const CHIP_BUDGETS_KB: Record<string, number> = {
  esp32: 200,
  esp32c3: 180,
  esp32c5: 240,
  esp32c6: 240,
  esp32s3: 260,
}

interface ProfileEntry {
  name: string
  deltaBytes: number
  order: number
}

interface RunConfig {
  entry?: string
  memLimit?: string
  memoryBudget?: number
  chip?: string
  top?: number
  sort?: string
  minBytes?: number
  includeNative?: boolean
  includeBuiltins?: boolean
  onlyNative?: boolean
  onlyBuiltins?: boolean
  bundle?: boolean
  noBundle?: boolean
  noMinify?: boolean
  minifier?: string
  minifyLevel?: string
  json?: boolean
  env?: string
  noAutoEnv?: boolean
}

export async function run(config: RunConfig): Promise<void> {
  try {
    await runImpl(config)
  } catch (err) {
    if (err instanceof SimAlreadyRunningError) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
    console.error(`mikro sim profile failed: ${err instanceof Error ? err.message : String(err)}`)
    if (err instanceof Error && err.stack) console.error(err.stack)
    process.exit(1)
  }
}

async function runImpl(config: RunConfig): Promise<void> {
  const mikroDir = getMikroDir()
  checkPid(mikroDir)

  const entry = resolveEntry(config.entry)
  const buildDir = pathlib.join(getMikroDir(), 'build')
  const log = (msg: string) => console.error(msg)

  const minify = !config.noMinify
  const minifier = parseMinifier(config.minifier)
  const minifyLevel = parseMinifyLevel(config.minifyLevel)

  log(`Building ${entry}…`)
  const bundle = config.noBundle === true ? false : config.bundle === true ? true : undefined
  await lastValueFrom(
    build(entry, buildDir, {
      minify,
      bytecode: true,
      minifier,
      minifyLevel,
      bundle,
      env: 'development',
    }),
    {defaultValue: undefined},
  )
  const files = await collectFiles(buildDir)
  log(`Built ${files.length} file(s)`)

  const envVars = [
    {key: 'MIKRO_ENV', value: 'development', secret: false},
    ...(await loadEnvFiles({
      cwd: resolveProjectRoot(),
      mode: 'development',
      envFile: config.env,
      noAutoEnv: config.noAutoEnv === true,
    })),
  ]

  const sim = await loadSimConfig(pathlib.dirname(entry))

  // Wipe any previously-deployed app from sim-fs before connecting. The first
  // simProcess spawned by connectSim calls bootRuntime() on startup, which
  // evaluates whatever was previously staged in sim-fs/app. If the last run
  // left a broken app there, that boot crashes and we never get to deploy the
  // fresh build. Since profile is a one-shot transient operation, blowing
  // away the prior state is always the right thing.
  const appDir = pathlib.join(sim.fsRoot, 'app')
  if (existsSync(appDir)) rmSync(appDir, {force: true, recursive: true})

  const profileMemLimit = config.memLimit
    ? parseSize(config.memLimit)
    : DEFAULT_PROFILE_MEM_LIMIT_BYTES

  log('Staging to simulator…')
  const stage = connectSim(sim, {memLimitOverride: profileMemLimit})
  try {
    const last = await lastValueFrom(
      stage.session.deploy({files, envVars, erase: true, restart: false}),
    )
    if (last.type !== 'complete') throw new Error('Deploy did not complete')
  } finally {
    stage.session.close()
    stage.transport.close()
  }

  const tmpDir = tmpdir()
  mkdirSync(tmpDir, {recursive: true})
  const profilePath = pathlib.join(tmpDir, `mikro-profile-${process.pid}.json`)

  try {
    log('Profiling…')
    await runProfileSubprocess(sim.fsRoot, profileMemLimit, profilePath)
    const {entries, baseline} = readProfile(profilePath)
    if (entries.length === 0) {
      log('Warning: profile is empty. No modules were loaded during boot.')
    }
    renderProfile(entries, {
      baseline,
      memoryBudgetKB: resolveBudget(config.memoryBudget, config.chip),
      chipName: config.chip,
      top: config.top,
      sort: (config.sort as 'size' | 'order' | undefined) ?? 'size',
      minBytes: config.minBytes ?? 0,
      includeNative: config.includeNative === true,
      includeBuiltins: config.includeBuiltins === true,
      onlyNative: config.onlyNative === true,
      onlyBuiltins: config.onlyBuiltins === true,
      json: config.json === true,
    })
  } finally {
    try {
      rmSync(profilePath, {force: true})
    } catch {
      // best-effort cleanup
    }
  }
}

function resolveBudget(explicit: number | undefined, chip: string | undefined): number | null {
  if (explicit !== undefined) return explicit
  if (chip !== undefined) {
    const preset = CHIP_BUDGETS_KB[chip]
    if (preset === undefined) {
      console.error(
        `Unknown chip '${chip}'. Known: ${Object.keys(CHIP_BUDGETS_KB).join(', ')}. ` +
          `Use --memory-budget to set an explicit value.`,
      )
      process.exit(1)
    }
    return preset
  }
  return null
}

function runProfileSubprocess(
  fsRoot: string,
  memLimitBytes: number,
  profilePath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Mirror createSimTransport: in workspace dev mode the package is loaded
    // from src/ via tsx, so we spawn the .ts source rather than a non-existent
    // .js sibling. The mikrojs launcher (bin/mikrojs.js) sets
    // NODE_OPTIONS=--import=tsx in that case, which this subprocess inherits.
    // Keep the URL literal as `.js` so static tools (knip) can resolve it back
    // to the .ts source.
    const isWorkspace = process.env['MIKROJS_WORKSPACE'] === '1'
    const entryUrl = new URL('../../../simulator/simProcess.js', import.meta.url)
    const entryPath = fileURLToPath(
      isWorkspace ? new URL(entryUrl.href.replace(/\.js$/, '.ts')) : entryUrl,
    )
    const childArgs = [
      entryPath,
      '--fs-root',
      fsRoot,
      '--mem-limit',
      String(memLimitBytes),
      '--profile-output',
      profilePath,
    ]
    const stdoutChunks: Buffer[] = []
    const child = spawn(process.execPath, childArgs, {stdio: ['ignore', 'pipe', 'inherit']})
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      const stdoutPreview = Buffer.concat(stdoutChunks).toString('utf-8').slice(0, 500)
      const tail = stdoutPreview ? `\nsimProcess stdout: ${stdoutPreview}` : ''
      reject(
        new Error(
          `simProcess exited with code=${code} signal=${signal ?? 'none'}\n` +
            `  node ${childArgs.join(' ')}${tail}`,
        ),
      )
    })
  })
}

function readProfile(profilePath: string): {entries: ProfileEntry[]; baseline: number} {
  if (!existsSync(profilePath)) {
    throw new Error(
      `simProcess did not write profile to ${profilePath}. ` +
        `This usually means bootRuntime failed or no app was deployed.`,
    )
  }
  const raw = readFileSync(profilePath, 'utf-8')
  const parsed = JSON.parse(raw) as {entries: ProfileEntry[]; baseline?: number}
  return {entries: parsed.entries, baseline: parsed.baseline ?? 0}
}

interface RenderOptions {
  baseline: number
  memoryBudgetKB: number | null
  chipName: string | undefined
  top: number | undefined
  sort: 'size' | 'order'
  minBytes: number
  includeNative: boolean
  includeBuiltins: boolean
  onlyNative: boolean
  onlyBuiltins: boolean
  json: boolean
}

type EntryKind = 'native' | 'builtin' | 'user'

function classifyEntry(name: string): EntryKind {
  if (name.startsWith('native:')) return 'native'
  if (name.startsWith('mikrojs/')) return 'builtin'
  return 'user'
}

function renderProfile(entries: ProfileEntry[], opts: RenderOptions): void {
  // Whitelist mode: if any --only-* flag is set, only those kinds are shown
  // and --include-* is ignored. Otherwise we hide runtime kinds by default
  // and the user opts in via --include-*.
  const whitelistMode = opts.onlyNative || opts.onlyBuiltins
  const showNative = whitelistMode ? opts.onlyNative : opts.includeNative
  const showBuiltins = whitelistMode ? opts.onlyBuiltins : opts.includeBuiltins
  const showUser = !whitelistMode

  const nativeEntries = entries.filter((e) => classifyEntry(e.name) === 'native')
  const builtinEntries = entries.filter((e) => classifyEntry(e.name) === 'builtin')
  const userEntries = entries.filter((e) => classifyEntry(e.name) === 'user')

  const visibleEntries = entries.filter((e) => {
    const kind = classifyEntry(e.name)
    if (kind === 'native') return showNative
    if (kind === 'builtin') return showBuiltins
    return showUser
  })

  const filtered = visibleEntries.filter((e) => e.deltaBytes >= opts.minBytes)
  const sorted =
    opts.sort === 'order'
      ? [...filtered].sort((a, b) => a.order - b.order)
      : [...filtered].sort((a, b) => b.deltaBytes - a.deltaBytes)
  const displayed = opts.top !== undefined ? sorted.slice(0, opts.top) : sorted

  const visibleTotalBytes = visibleEntries.reduce((sum, e) => sum + e.deltaBytes, 0)
  const nativeTotalBytes = nativeEntries.reduce((sum, e) => sum + e.deltaBytes, 0)
  const builtinTotalBytes = builtinEntries.reduce((sum, e) => sum + e.deltaBytes, 0)
  const userTotalBytes = userEntries.reduce((sum, e) => sum + e.deltaBytes, 0)

  // In whitelist mode, users asked for a specific view — don't add noise
  // about what's hidden. In default mode, surface runtime cost explicitly
  // so it's clear why the number is lower than expected.
  const hiddenNative = !whitelistMode && !showNative && nativeEntries.length > 0
  const hiddenBuiltins = !whitelistMode && !showBuiltins && builtinEntries.length > 0
  const hiddenUser = whitelistMode && userEntries.length > 0

  const baselineKB = opts.baseline / 1024
  const allModuleTotalBytes = entries.reduce((sum, e) => sum + e.deltaBytes, 0)
  const grandTotalKB = (opts.baseline + allModuleTotalBytes) / 1024

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          baseline: opts.baseline,
          moduleCount: visibleEntries.length,
          totalBytes: visibleTotalBytes,
          grandTotalBytes: opts.baseline + allModuleTotalBytes,
          budgetBytes: opts.memoryBudgetKB !== null ? opts.memoryBudgetKB * 1024 : null,
          entries: displayed,
          hidden: {
            native: hiddenNative ? {count: nativeEntries.length, bytes: nativeTotalBytes} : null,
            builtins: hiddenBuiltins
              ? {count: builtinEntries.length, bytes: builtinTotalBytes}
              : null,
            user: hiddenUser ? {count: userEntries.length, bytes: userTotalBytes} : null,
          },
        },
        null,
        2,
      ),
    )
    return
  }

  const totalKB = visibleTotalBytes / 1024
  const budgetBytes = opts.memoryBudgetKB !== null ? opts.memoryBudgetKB * 1024 : null

  console.log(`QuickJS baseline: ${baselineKB.toFixed(1)} KB (runtime + context + intrinsics)`)
  const header = `Module profile: ${visibleEntries.length} modules, ${totalKB.toFixed(1)} KB load cost, ${grandTotalKB.toFixed(1)} KB total`
  console.log(header)
  console.log(dim(`  Load cost only; linking + evaluation overhead not included`))
  if (hiddenNative) {
    const kb = nativeTotalBytes / 1024
    console.log(
      dim(
        `  ${nativeEntries.length} native:* module(s) hidden (${kb.toFixed(1)} KB). Pass --include-native to show.`,
      ),
    )
  }
  if (hiddenBuiltins) {
    const kb = builtinTotalBytes / 1024
    console.log(
      dim(
        `  ${builtinEntries.length} mikrojs/* module(s) hidden (${kb.toFixed(1)} KB). Pass --include-builtins to show.`,
      ),
    )
  }
  if (hiddenUser) {
    const kb = userTotalBytes / 1024
    console.log(
      dim(`  ${userEntries.length} user module(s) hidden (${kb.toFixed(1)} KB) by --only-*.`),
    )
  }
  if (budgetBytes !== null) {
    const pct = (visibleTotalBytes / budgetBytes) * 100
    const budgetLabel = opts.chipName
      ? `${opts.memoryBudgetKB} KB (${opts.chipName})`
      : `${opts.memoryBudgetKB} KB`
    const footer = `Budget: ${budgetLabel}, used ${totalKB.toFixed(1)} KB (${pct.toFixed(0)}%)`
    console.log(pct > 100 ? red(footer) : pct >= 80 ? yellow(footer) : footer)
  }
  console.log('')

  const nameWidth = Math.min(Math.max(10, ...displayed.map((e) => e.name.length)), 60)
  const sizeHeader = 'Size'
  const cumHeader = 'Cumulative'

  console.log(
    `  ${'Module'.padEnd(nameWidth)}  ${sizeHeader.padStart(8)}  ${cumHeader.padStart(12)}`,
  )

  let cumulative = 0
  for (const entry of displayed) {
    cumulative += entry.deltaBytes
    const sizeCell = formatKB(entry.deltaBytes).padStart(8)
    const cumCell = formatKB(cumulative).padStart(12)
    const nameCell = truncate(entry.name, nameWidth).padEnd(nameWidth)
    const row = `  ${nameCell}  ${sizeCell}  ${cumCell}`
    console.log(colorizeRow(row, entry.deltaBytes, cumulative, budgetBytes))
  }
}

function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function colorizeRow(
  row: string,
  deltaBytes: number,
  cumulative: number,
  budgetBytes: number | null,
): string {
  if (budgetBytes === null) return row
  if (deltaBytes > budgetBytes * 0.25) return red(row)
  if (cumulative > budgetBytes) return red(row)
  if (deltaBytes > Math.min(budgetBytes * 0.1, 10 * 1024)) return yellow(row)
  return row
}

const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
