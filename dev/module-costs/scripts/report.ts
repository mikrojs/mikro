/* eslint-disable no-console */
// Prints the import cost of every builtin per chip: each file's figure minus
// the _baseline file's, read from __heap_snapshots__/<chip>.json.
import {readdirSync, readFileSync} from 'node:fs'
import * as pathlib from 'node:path'

interface Figures {
  heapDelta: number
  sysUsed?: number
}

const dir = pathlib.join(import.meta.dirname, '../__heap_snapshots__')
const BASELINE = 'test/_baseline.test.ts'

const chips: {chip: string; tests: Record<string, Figures>}[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({
    chip: f.slice(0, -'.json'.length),
    tests: JSON.parse(readFileSync(pathlib.join(dir, f), 'utf-8')).tests ?? {},
  }))

const modules = [...new Set(chips.flatMap((c) => Object.keys(c.tests)))]
  .filter((k) => k !== BASELINE)
  .sort()

function moduleName(key: string): string {
  return (
    'mikro/' +
    key
      .replace(/^test\//, '')
      .replace(/\.test\.ts$/, '')
      .replaceAll('-', '/')
  )
}

function table(field: keyof Figures, title: string): void {
  const cols = chips.filter((c) => c.tests[BASELINE]?.[field] !== undefined)
  if (cols.length === 0) return
  const rows = modules.map((m) => [
    moduleName(m),
    ...cols.map((c) => {
      const v = c.tests[m]?.[field]
      const base = c.tests[BASELINE]![field]!
      return v === undefined ? '' : String(v - base)
    }),
  ])
  console.log(`\n${title} (bytes above _baseline)\n`)
  console.log(`| module | ${cols.map((c) => c.chip).join(' | ')} |`)
  console.log(`| --- | ${cols.map(() => '---:').join(' | ')} |`)
  for (const r of rows) console.log(`| ${r.join(' | ')} |`)
}

table('heapDelta', 'Retained JS heap')
table('sysUsed', 'System heap peak')
