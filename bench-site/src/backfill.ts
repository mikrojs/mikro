#!/usr/bin/env -S node --experimental-strip-types
// Backfill historical bench data by walking git history, rebuilding and
// running memory_bench at each selected commit, and appending to data.js.
//
// Meant to be invoked by the `memory-bench-backfill` workflow_dispatch so
// all samples share the ubuntu-latest hardware baseline with regular CI.
//
// Example:
//   tsx src/backfill.ts \
//     --repo-root /path/to/mikrojs \
//     --range main~200..main \
//     --step 5 \
//     --out /path/to/gh-pages/dev/bench/data.js \
//     --repo-url https://github.com/owner/mikrojs \
//     --skip-existing

import {execFileSync, execSync} from 'node:child_process'
import {existsSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {type Bench, type BenchmarkData, type Entry, parseDataJs, serializeDataJs} from './data.ts'

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = 'true'
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

const repoRoot = resolve(args['repo-root'] ?? process.env.GITHUB_WORKSPACE ?? process.cwd())
const outPath = args.out
const repoUrl = args['repo-url']
const range = args.range
const step = parseInt(args.step ?? '1', 10)
const skipExisting = args['skip-existing'] === 'true'
const workdir = resolve(args.workdir ?? `/tmp/bench-backfill-${process.pid}`)

if (!outPath || !repoUrl || !range) {
  console.error(
    'usage: backfill --out <data.js> --repo-url <url> --range <git-range> [--step N] [--skip-existing] [--repo-root DIR] [--workdir DIR]',
  )
  process.exit(1)
}

function git(cwd: string, ...gitArgs: string[]): string {
  return execFileSync('git', gitArgs, {cwd, encoding: 'utf8'}).trim()
}

function shellOut(cmd: string, cwd: string): void {
  execSync(cmd, {cwd, stdio: 'inherit'})
}

// Load or seed data.js
let data: BenchmarkData
if (existsSync(outPath)) {
  data = parseDataJs(readFileSync(outPath, 'utf8'))
} else {
  data = {lastUpdate: 0, repoUrl, entries: {Benchmark: []}}
}
const key = Object.keys(data.entries)[0] ?? 'Benchmark'
const list: Entry[] = data.entries[key] ?? (data.entries[key] = [])
const existingShas = new Set(list.map((e) => e.commit.id))

// Walk commits oldest → newest so sampling is stable
const shas = git(repoRoot, 'rev-list', '--reverse', range).split('\n').filter(Boolean)
const selected = shas.filter((_, i) => i % step === 0)
console.log(
  `backfill: ${shas.length} commits in range, sampling every ${step} → ${selected.length} candidates`,
)

// Prepare an isolated worktree we'll keep re-checking out
if (existsSync(workdir)) {
  try {
    git(repoRoot, 'worktree', 'remove', '--force', workdir)
  } catch {
    rmSync(workdir, {recursive: true, force: true})
  }
}
git(repoRoot, 'worktree', 'add', '--detach', workdir, selected[0]!)

let ok = 0
let skipped = 0
let failed = 0

for (const sha of selected) {
  if (skipExisting && existingShas.has(sha)) {
    console.log(`skip ${sha.slice(0, 7)} (already in data.js)`)
    skipped++
    continue
  }

  const short = sha.slice(0, 7)
  console.log(`\n=== ${short} ===`)
  try {
    git(workdir, 'checkout', '--detach', '--force', sha)
    git(
      workdir,
      'submodule',
      'update',
      '--init',
      'packages/@mikrojs/quickjs/deps/quickjs',
      'packages/@mikrojs/native/deps/nanocbor',
    )

    shellOut('pnpm install --frozen-lockfile --prefer-offline', workdir)

    // Some old commits may have a different CMake layout; let failures bubble
    // up per-commit via the try/catch rather than aborting the whole run.
    shellOut(
      'cmake -B packages/@mikrojs/native/build packages/@mikrojs/native -DBUILD_TESTING=ON',
      workdir,
    )
    shellOut('cmake --build packages/@mikrojs/native/build --target memory_bench', workdir)

    const json = execFileSync('packages/@mikrojs/native/build/memory_bench', [], {
      cwd: workdir,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    const benches: Bench[] = JSON.parse(json)

    // Size report: strip the binary, then measure from the worktree root
    try {
      execFileSync('strip', ['packages/@mikrojs/native/build/memory_bench'], {cwd: workdir})
    } catch {
      /* strip may warn on already-stripped binaries; ignore */
    }
    for (const t of [
      {label: 'libmikrojs.a', path: 'packages/@mikrojs/native/build/libmikrojs.a'},
      {label: 'libquickjs.a', path: 'packages/@mikrojs/native/build/libquickjs.a'},
      {label: 'memory_bench (stripped)', path: 'packages/@mikrojs/native/build/memory_bench'},
    ]) {
      const p = resolve(workdir, t.path)
      if (!existsSync(p)) continue
      const bytes = statSync(p).size
      benches.push({
        name: `binary_size — ${t.label}`,
        unit: 'KB',
        value: Number((bytes / 1024).toFixed(2)),
        extra: `${bytes} bytes`,
      })
    }

    const meta = git(workdir, 'show', '--no-patch', '--format=%H%x1f%cI%x1f%an%x1f%ae%x1f%s', sha)
    const [, iso, authorName, authorEmail, message] = meta.split('\x1f')
    const commitDate = new Date(iso!).getTime()

    list.push({
      commit: {
        author: {name: authorName ?? '', email: authorEmail ?? '', username: ''},
        committer: {name: authorName ?? '', email: authorEmail ?? '', username: ''},
        distinct: true,
        id: sha,
        message: message ?? '',
        timestamp: iso!,
        tree_id: '',
        url: `${repoUrl}/commit/${sha}`,
      },
      date: commitDate,
      tool: 'customSmallerIsBetter',
      benches,
    })
    existingShas.add(sha)
    ok++
    console.log(`ok  ${short} (${benches.length} metrics)`)

    // Persist incrementally so a mid-run failure doesn't lose prior work.
    data.entries[key] = list.slice().sort((a, b) => a.date - b.date)
    data.lastUpdate = Math.max(data.lastUpdate, ...list.map((e) => e.date))
    data.repoUrl = repoUrl
    writeFileSync(outPath, serializeDataJs(data))
  } catch (err) {
    failed++
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`FAIL ${short}: ${msg.split('\n')[0]}`)
  }
}

// Clean up the worktree (best-effort)
try {
  git(repoRoot, 'worktree', 'remove', '--force', workdir)
} catch {
  rmSync(workdir, {recursive: true, force: true})
}

console.log(`\ndone: ok=${ok} skipped=${skipped} failed=${failed} total=${selected.length}`)
if (ok === 0 && failed > 0) process.exit(1)
