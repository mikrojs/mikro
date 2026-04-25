#!/usr/bin/env -S node --experimental-strip-types
// Append a new bench run to a data.js file in the github-action-benchmark
// format. Creates the file if missing.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'

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
const required = [
  'results',
  'out',
  'repo-url',
  'commit-sha',
  'commit-message',
  'commit-url',
] as const

for (const k of required) {
  if (!args[k]) {
    console.error(`missing --${k}`)
    process.exit(1)
  }
}

const benches: Bench[] = JSON.parse(readFileSync(args.results!, 'utf8'))
if (!Array.isArray(benches)) {
  console.error('results must be a JSON array')
  process.exit(1)
}

let data: BenchmarkData
if (existsSync(args.out!)) {
  data = parseDataJs(readFileSync(args.out!, 'utf8'))
} else {
  data = {lastUpdate: 0, repoUrl: args['repo-url']!, entries: {Benchmark: []}}
  mkdirSync(dirname(args.out!), {recursive: true})
}

const key = Object.keys(data.entries)[0] ?? 'Benchmark'
const list: Entry[] = data.entries[key] ?? (data.entries[key] = [])

const now = args['commit-date'] ? new Date(args['commit-date']).getTime() : Date.now()
list.push({
  commit: {
    author: {name: args['author-name'] ?? '', email: args['author-email'] ?? '', username: ''},
    committer: {
      name: args['author-name'] ?? '',
      email: args['author-email'] ?? '',
      username: '',
    },
    distinct: true,
    id: args['commit-sha']!,
    message: args['commit-message']!,
    timestamp: new Date(now).toISOString(),
    tree_id: '',
    url: args['commit-url']!,
  },
  date: now,
  tool: 'customSmallerIsBetter',
  benches,
})

const max = parseInt(args['max-entries'] ?? '500', 10)
if (list.length > max) data.entries[key] = list.slice(-max)

data.lastUpdate = Math.max(data.lastUpdate, now)
data.repoUrl = args['repo-url']!

if (args.sort === 'true' || args.sort === 'date') {
  data.entries[key] = data.entries[key]!.slice().sort((a, b) => a.date - b.date)
}

writeFileSync(args.out!, serializeDataJs(data))
console.log(`appended run; total entries: ${data.entries[key]!.length}`)
