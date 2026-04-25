#!/usr/bin/env -S node --experimental-strip-types
// Fail the build if any metric in --results is worse than the last main-branch
// run (fetched from the bench-data branch) by more than --threshold (e.g. 1.10 = +10%).

import {readFileSync} from 'node:fs'

import {type Bench, type Entry, parseDataJs} from './data.ts'

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
const threshold = parseFloat(args.threshold ?? '1.10')
const results: Bench[] = JSON.parse(readFileSync(args.results!, 'utf8'))

const repoSlug = process.env.GITHUB_REPOSITORY ?? ''
const [owner, repo] = repoSlug.split('/')
if (!owner || !repo) {
  console.log('no GITHUB_REPOSITORY; skipping regression check')
  process.exit(0)
}

const url =
  args['data-url'] ??
  `https://raw.githubusercontent.com/${owner}/${repo}/bench-data/dev/bench/data.js`

const res = await fetch(url).catch((e: unknown) => ({
  ok: false,
  status: 0,
  _err: e instanceof Error ? e.message : String(e),
  text: () => Promise.resolve(''),
}))

if (!res.ok) {
  // 404 is the only "expected" absence: bench-data not yet seeded. Anything
  // else (DNS failure, 5xx, network error) is suspicious and should fail the
  // build so we notice instead of silently passing every PR.
  if (res.status === 404) {
    console.log(`no baseline at ${url} (404); skipping`)
    process.exit(0)
  }
  const detail = 'status' in res && res.status ? `HTTP ${res.status}` : (res as {_err: string})._err
  console.error(`baseline fetch failed: ${detail}`)
  process.exit(1)
}

const body = await res.text()
// Parse errors are also fatal — a corrupt baseline would silently green-light
// every regression check otherwise.
const data = parseDataJs(body)
const key = Object.keys(data.entries)[0]
const baseline: Entry | undefined = key ? data.entries[key]?.at(-1) : undefined

if (!baseline) {
  console.log('no baseline entries; skipping')
  process.exit(0)
}

const baselineByName = new Map(baseline.benches.map((b) => [b.name, b.value]))
const regressions: {name: string; prev: number; cur: number; pct: string}[] = []
for (const cur of results) {
  const prev = baselineByName.get(cur.name)
  if (prev == null || prev === 0) continue
  const ratio = cur.value / prev
  if (ratio > threshold) {
    regressions.push({
      name: cur.name,
      prev,
      cur: cur.value,
      pct: ((ratio - 1) * 100).toFixed(2),
    })
  }
}

if (regressions.length === 0) {
  console.log(`no regressions vs. ${baseline.commit.id.slice(0, 7)}`)
  process.exit(0)
}

console.error(`Regression vs. ${baseline.commit.id.slice(0, 7)}:`)
for (const r of regressions) {
  console.error(`  ${r.name}: ${r.prev.toFixed(2)} → ${r.cur.toFixed(2)} (+${r.pct}%)`)
}
process.exit(1)
