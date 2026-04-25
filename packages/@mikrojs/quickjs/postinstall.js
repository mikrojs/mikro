#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Build the qjsc bytecode compiler from QuickJS source at install time.
 * Produces bin/qjsc in the package directory.
 *
 * Uses cc directly (no cmake dependency) since qjsc is just a few C files.
 * Skips gracefully if cc or the submodule is not available.
 */
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const binDir = join(__dirname, 'bin')
const qjsDir = join(__dirname, 'deps', 'quickjs')
const patchesDir = join(__dirname, 'patches')
const repoRoot = join(__dirname, '..', '..', '..')

// Always sync submodule to the pinned commit
try {
  execFileSync('git', ['submodule', 'update', '--init', 'packages/@mikrojs/quickjs/deps/quickjs'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
} catch {
  if (!existsSync(join(qjsDir, 'quickjs.c'))) {
    console.error(
      '@mikrojs/quickjs: Failed to initialize QuickJS submodule.\n' +
        'Run manually: git submodule update --init packages/@mikrojs/quickjs/deps/quickjs',
    )
    process.exit(1)
  }
}

// Apply mikrojs-local patches to the submodule tree. Patches live in
// packages/@mikrojs/quickjs/patches/*.patch and are kept minimal.
// Applied idempotently: if `git apply --reverse --check` succeeds, the
// patch is already present, skip it.
applyPatches()

function applyPatches() {
  if (!existsSync(patchesDir)) return
  const files = readdirSync(patchesDir)
    .filter((f) => f.endsWith('.patch'))
    .sort()
  for (const f of files) {
    const patch = join(patchesDir, f)
    // Probe: is the patch already applied?
    try {
      execFileSync('git', ['apply', '--reverse', '--check', patch], {
        cwd: qjsDir,
        stdio: 'pipe',
      })
      continue // already applied
    } catch {
      // not applied — fall through
    }
    try {
      execFileSync('git', ['apply', patch], {cwd: qjsDir, stdio: 'inherit'})
      console.log(`@mikrojs/quickjs: applied patch ${f}`)
    } catch (err) {
      console.error(`@mikrojs/quickjs: failed to apply ${f}`, err.message)
      process.exit(1)
    }
  }
}

// Determine the current submodule commit to detect changes
let currentCommit = ''
try {
  currentCommit = execFileSync('git', ['-C', qjsDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
} catch {
  // Not a git repo (e.g. published package), skip commit tracking
}

// On Windows the C compiler appends .exe automatically.
const exeSuffix = process.platform === 'win32' ? '.exe' : ''
const qjscPath = join(binDir, `qjsc${exeSuffix}`)

// Skip rebuild if qjsc exists and source hasn't changed
const stampFile = join(binDir, '.commit')
if (existsSync(qjscPath)) {
  if (!currentCommit) {
    // No git info (npm install): qjsc exists, sources are static, skip rebuild
    process.exit(0)
  }
  const builtCommit = existsSync(stampFile) ? readFileSync(stampFile, 'utf8').trim() : ''
  if (builtCommit === currentCommit) {
    process.exit(0)
  }
}

// Skip if cc is not available
try {
  execFileSync('cc', ['--version'], {stdio: 'ignore'})
} catch {
  console.log('@mikrojs/quickjs: C compiler not found, skipping qjsc build')
  process.exit(0)
}

mkdirSync(binDir, {recursive: true})

const output = qjscPath
const sources = [
  'quickjs.c',
  'dtoa.c',
  'libunicode.c',
  'libregexp.c',
  'quickjs-libc.c',
  'qjsc.c',
].map((f) => join(qjsDir, f))

console.log('@mikrojs/quickjs: Building qjsc...')
execFileSync('cc', ['-O2', '-D_GNU_SOURCE', '-I', qjsDir, '-o', output, ...sources, '-lm'], {
  stdio: 'inherit',
})

if (currentCommit) {
  writeFileSync(stampFile, currentCommit)
}
console.log('@mikrojs/quickjs: qjsc built successfully')
