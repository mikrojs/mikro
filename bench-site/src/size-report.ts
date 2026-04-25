#!/usr/bin/env -S node --experimental-strip-types
// Measure binary sizes of build artifacts and append entries to an existing
// bench-results.json (customSmallerIsBetter format). Run after memory_bench
// in CI so size regressions show up alongside heap regressions.

import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import {basename, resolve} from 'node:path'

import type {Bench} from './data.ts'

interface Target {
  label: string
  path: string
  /** Optional KB divisor; use 'B' for tiny files, default 'KB'. */
  unit?: 'B' | 'KB'
}

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
const resultsPath = args.results
if (!resultsPath) {
  console.error(
    'usage: size-report --results <bench-results.json> [--cwd <dir>] [--target label=path ...]',
  )
  process.exit(1)
}

const cwd = args.cwd ?? process.env.GITHUB_WORKSPACE ?? process.cwd()
const defaults: Target[] = [
  {label: 'libmikrojs.a', path: 'packages/@mikrojs/native/build/libmikrojs.a'},
  {label: 'libquickjs.a', path: 'packages/@mikrojs/native/build/libquickjs.a'},
  {label: 'memory_bench (stripped)', path: 'packages/@mikrojs/native/build/memory_bench'},
]

const cliTargets: Target[] = []
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--target') continue
  const spec = process.argv[i + 1]
  if (!spec) continue
  const eq = spec.indexOf('=')
  if (eq < 0) continue
  cliTargets.push({label: spec.slice(0, eq), path: spec.slice(eq + 1)})
}

const targets = cliTargets.length > 0 ? cliTargets : defaults

const newBenches: Bench[] = []
for (const t of targets) {
  const p = resolve(cwd, t.path)
  if (!existsSync(p)) {
    console.warn(`size-report: skip ${t.label} (missing: ${p})`)
    continue
  }
  const bytes = statSync(p).size
  const unit = t.unit ?? 'KB'
  const value = unit === 'B' ? bytes : bytes / 1024
  newBenches.push({
    name: `binary_size — ${t.label}`,
    unit,
    value: Number(value.toFixed(2)),
    extra: `${bytes} bytes (${basename(p)})`,
  })
}

const existing: Bench[] = JSON.parse(readFileSync(resultsPath, 'utf8'))
const merged = [...existing, ...newBenches]
writeFileSync(resultsPath, JSON.stringify(merged, null, 2))
console.log(`size-report: appended ${newBenches.length} entries to ${resultsPath}`)
