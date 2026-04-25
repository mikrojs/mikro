/** Shared types matching the github-action-benchmark data.js format. */

export interface Bench {
  name: string
  unit: string
  value: number
  extra?: string
}

export interface CommitPerson {
  name: string
  email: string
  username: string
}

export interface CommitInfo {
  author: CommitPerson
  committer: CommitPerson
  distinct: boolean
  id: string
  message: string
  timestamp: string
  tree_id: string
  url: string
}

export interface Entry {
  commit: CommitInfo
  date: number
  tool: string
  benches: Bench[]
}

export interface BenchmarkData {
  lastUpdate: number
  repoUrl: string
  entries: Record<string, Entry[]>
}

/** Parse the `window.BENCHMARK_DATA = {...};` assignment format. */
export function parseDataJs(src: string): BenchmarkData {
  const json = src.replace(/^\s*window\.BENCHMARK_DATA\s*=\s*/, '').replace(/;\s*$/, '')
  return JSON.parse(json) as BenchmarkData
}

export function serializeDataJs(data: BenchmarkData): string {
  return `window.BENCHMARK_DATA = ${JSON.stringify(data, null, 2)}`
}
