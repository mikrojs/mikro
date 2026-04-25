#!/usr/bin/env node

/**
 * Compare minifier output sizes for firmware runtime modules.
 *
 * Usage: node scripts/compare-minifiers.js [--open]
 *
 * Builds runtime modules with each minifier/level combination, collects
 * bundle sizes, and writes an HTML report to compare-minifiers.html.
 * Pass --open to open the report in the default browser.
 */

import {execSync} from 'node:child_process'
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '../..')
const CONFIGS = [
  {name: 'esbuild', args: ''},
  {name: 'terser', args: '-DMIK_MINIFIER=terser'},
  {name: 'terser max', args: '-DMIK_MINIFIER=terser -DMIK_MINIFY_LEVEL=max'},
  {name: 'swc', args: '-DMIK_MINIFIER=swc'},
  {name: 'swc max', args: '-DMIK_MINIFIER=swc -DMIK_MINIFY_LEVEL=max'},
]

function run(cmd) {
  return execSync(cmd, {cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']})
}

function parseBundleOutput(output) {
  const modules = new Map()
  for (const match of output.matchAll(/Bundled (\S+) \((\d+) bytes/g)) {
    modules.set(match[1], Number(match[2]))
  }
  return modules
}

function buildConfig(config) {
  const buildDir = join(ROOT, `.compare-${config.name.replace(/\s+/g, '-')}`)
  if (existsSync(buildDir)) rmSync(buildDir, {recursive: true, force: true})
  mkdirSync(buildDir, {recursive: true})

  const configureCmd = `cmake -B ${buildDir} ${config.args} .`
  run(configureCmd)

  const buildCmd = `cmake --build ${buildDir} --target gen_bytecode`
  const output = run(buildCmd)

  const modules = parseBundleOutput(output)
  rmSync(buildDir, {recursive: true, force: true})
  return modules
}

// Run all builds
// eslint-disable-next-line no-console
console.log('Comparing minifiers for firmware runtime modules...\n')
const results = []
for (const config of CONFIGS) {
  process.stdout.write(`  Building with ${config.name}...`)
  const start = Date.now()
  const modules = buildConfig(config)
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  // eslint-disable-next-line no-console
  console.log(` ${modules.size} modules (${elapsed}s)`)
  results.push({name: config.name, modules})
}

// Collect all module names
const allModules = [...new Set(results.flatMap((r) => [...r.modules.keys()]))].sort()

// Find the baseline (esbuild)
const baseline = results[0].modules

// Generate HTML
function generateHtml() {
  const rows = allModules.map((mod) => {
    const cells = results.map((r) => {
      const size = r.modules.get(mod) ?? 0
      const base = baseline.get(mod) ?? 0
      const diff = size - base
      const pct = base > 0 ? ((diff / base) * 100).toFixed(1) : '—'
      return {size, diff, pct}
    })
    return {mod, cells}
  })

  const totals = results.map((r) => {
    const total = allModules.reduce((sum, mod) => sum + (r.modules.get(mod) ?? 0), 0)
    const baseTotal = allModules.reduce((sum, mod) => sum + (baseline.get(mod) ?? 0), 0)
    const diff = total - baseTotal
    const pct = baseTotal > 0 ? ((diff / baseTotal) * 100).toFixed(1) : '—'
    return {total, diff, pct}
  })

  const configHeaders = results.map((r) => `<th>${r.name}</th>`).join('\n            ')

  const tableRows = rows
    .map(({mod, cells}) => {
      const tds = cells
        .map(({size, diff, pct}, i) => {
          if (i === 0) return `<td class="num">${size}</td>`
          const cls = diff < 0 ? 'better' : diff > 0 ? 'worse' : 'same'
          const sign = diff > 0 ? '+' : ''
          return `<td class="num ${cls}">${size} <span class="diff">(${sign}${diff}, ${sign}${pct}%)</span></td>`
        })
        .join('\n              ')
      return `          <tr>
            <td class="mod">${mod}</td>
            ${tds}
          </tr>`
    })
    .join('\n')

  const totalRow = totals
    .map(({total, diff, pct}, i) => {
      if (i === 0) return `<td class="num"><strong>${total}</strong></td>`
      const cls = diff < 0 ? 'better' : diff > 0 ? 'worse' : 'same'
      const sign = diff > 0 ? '+' : ''
      return `<td class="num ${cls}"><strong>${total}</strong> <span class="diff">(${sign}${diff}, ${sign}${pct}%)</span></td>`
    })
    .join('\n            ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Minifier Comparison — mikrojs firmware runtime modules</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; padding: 2rem; background: #f8f9fa; color: #1a1a1a; }
    h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
    .subtitle { color: #666; margin-bottom: 1.5rem; font-size: 0.9rem; }
    table { border-collapse: collapse; width: 100%; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th { background: #1a1a1a; color: white; padding: 0.6rem 1rem; text-align: left; font-weight: 500; font-size: 0.85rem; }
    td { padding: 0.45rem 1rem; border-bottom: 1px solid #eee; font-size: 0.85rem; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f5f5f5; }
    .mod { font-family: ui-monospace, monospace; font-size: 0.8rem; }
    .num { text-align: right; font-family: ui-monospace, monospace; font-size: 0.8rem; white-space: nowrap; }
    .diff { font-size: 0.75rem; opacity: 0.7; }
    .better { color: #16a34a; }
    .worse { color: #dc2626; }
    .same { color: #666; }
    .total-row td { border-top: 2px solid #1a1a1a; background: #f9fafb; }
    .legend { margin-top: 1rem; font-size: 0.8rem; color: #666; }
    .legend span { margin-right: 1.5rem; }
    .timestamp { margin-top: 0.5rem; font-size: 0.75rem; color: #999; }
  </style>
</head>
<body>
  <h1>Minifier Comparison</h1>
  <p class="subtitle">Bundle sizes (bytes) for mikrojs firmware runtime modules. Diff relative to esbuild baseline.</p>
  <table>
    <thead>
      <tr>
        <th>Module</th>
        ${configHeaders}
      </tr>
    </thead>
    <tbody>
${tableRows}
      <tr class="total-row">
        <td class="mod"><strong>Total</strong></td>
        ${totalRow}
      </tr>
    </tbody>
  </table>
  <p class="legend">
    <span class="better">Green = smaller than esbuild</span>
    <span class="worse">Red = larger than esbuild</span>
    <span class="same">Gray = same size</span>
  </p>
  <p class="timestamp">Generated ${new Date().toISOString()}</p>
</body>
</html>`
}

const html = generateHtml()
const outPath = join(ROOT, 'compare-minifiers.html')
writeFileSync(outPath, html)
// eslint-disable-next-line no-console
console.log(`\nReport written to ${outPath}`)

if (process.argv.includes('--open')) {
  const {platform} = await import('node:os')
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open'
  execSync(`${cmd} ${outPath}`)
}
