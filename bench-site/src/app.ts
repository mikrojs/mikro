import * as Plot from '@observablehq/plot'

import type {BenchmarkData, Entry} from './data.ts'

declare global {
  interface Window {
    BENCHMARK_DATA?: BenchmarkData
  }
}

interface Row {
  i: number
  date: Date
  value: number
  unit: string
  extra: string
  sha: string
  shaShort: string
  message: string
  author: string
  url: string
}

interface State {
  entries: Entry[]
  repoUrl: string
  selected: Set<string>
  filter: string
  log: boolean
  percent: boolean
  groupByUnit: boolean
  range: 'all' | '50' | '20'
}

const state: State = {
  entries: [],
  repoUrl: '',
  selected: new Set(),
  filter: '',
  log: false,
  percent: false,
  groupByUnit: true,
  range: 'all',
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(s)
  })
}

async function load(): Promise<void> {
  // data.js is a sibling file that assigns window.BENCHMARK_DATA. Inject as a
  // classic script (not ESM import) so esbuild doesn't try to bundle it.
  await loadScript(`./data.js?t=${Date.now()}`)
  const raw = window.BENCHMARK_DATA
  if (!raw) throw new Error('no BENCHMARK_DATA')
  state.repoUrl = raw.repoUrl || ''
  const firstKey = Object.keys(raw.entries)[0]
  state.entries = firstKey ? (raw.entries[firstKey] ?? []) : []
  const sub = document.getElementById('subtitle')
  if (sub) {
    sub.textContent = `${state.entries.length} runs, last updated ${new Date(raw.lastUpdate).toLocaleString()}`
  }
}

/** Order metrics by the most recent entry's bench sequence, then append any
 * historical-only names at the end. The bench emits checkpoints in a fixed
 * reading order (runtime_init → modules → steady_state → workload → binary_size),
 * and the latest run is the best source of truth for that ordering. */
function allMetricNames(): string[] {
  const names = new Set<string>()
  const latest = state.entries.at(-1)
  if (latest) for (const b of latest.benches) names.add(b.name)
  for (const e of state.entries) for (const b of e.benches) names.add(b.name)
  return [...names]
}

/** Accept only https://github.com/ URLs; fall back to a no-op anchor.
 * `row.url` ultimately comes from commit metadata written to data.js by CI,
 * which means any contributor can influence it. Setting an unvalidated URL
 * on <a href=""> is an XSS sink (javascript: URIs execute on click). */
function safeCommitUrl(url: string): string {
  return /^https:\/\/github\.com\//.test(url) ? url : '#'
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return map[c] ?? c
  })
}

function renderMetricList(): void {
  const list = document.getElementById('metricList')
  if (!list) return
  const q = state.filter.toLowerCase()
  const names = allMetricNames().filter((n) => n.toLowerCase().includes(q))
  list.innerHTML = ''
  for (const name of names) {
    const row = document.createElement('label')
    row.innerHTML = `<input type="checkbox" ${state.selected.has(name) ? 'checked' : ''}/><span>${escapeHtml(name)}</span>`
    const cb = row.querySelector('input')!
    cb.addEventListener('change', (ev) => {
      const target = ev.target as HTMLInputElement
      if (target.checked) state.selected.add(name)
      else state.selected.delete(name)
      renderCharts()
    })
    list.appendChild(row)
  }
}

function seriesFor(name: string): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < state.entries.length; i++) {
    const e = state.entries[i]!
    const b = e.benches.find((x) => x.name === name)
    if (!b) continue
    rows.push({
      i,
      date: new Date(e.date || e.commit.timestamp),
      value: b.value,
      unit: b.unit,
      extra: b.extra ?? '',
      sha: e.commit.id,
      shaShort: (e.commit.id || '').slice(0, 7),
      message: (e.commit.message || '').split('\n')[0] ?? '',
      author: e.commit.author?.name ?? '',
      url: e.commit.url || (state.repoUrl ? `${state.repoUrl}/commit/${e.commit.id}` : ''),
    })
  }
  return rows
}

function applyRange(rows: Row[]): Row[] {
  if (state.range === 'all') return rows
  const n = parseInt(state.range, 10)
  return rows.slice(-n)
}

function applyPercent(rows: Row[]): Row[] {
  if (!state.percent || rows.length === 0) return rows
  const base = rows[0]!.value || 1
  return rows.map((r) => ({...r, value: ((r.value - base) / base) * 100}))
}

/** Format "k=v k=v k=v" extras into a readable multi-line list. Returns the
 * original string if it doesn't look like that format. */
function formatExtra(extra: string): string {
  if (!extra) return ''
  // Heuristic: extras from memory_bench are space-separated k=v pairs; anything
  // else (human-readable sentences) we pass through unchanged.
  const pairs = extra.match(/\b[\w()]+=[^\s]+/g)
  if (!pairs || pairs.length < 2) return extra
  return pairs.map((p) => '  ' + p.replace('=', ' = ')).join('\n')
}

function tooltipText(d: Row, prev: Row | undefined): string {
  // Keep this short; Plot.tip truncates lines that don't fit inside the
  // plot's content area. Full breakdown lives in the click-through dialog.
  const truncMessage = d.message.length > 64 ? d.message.slice(0, 61) + '…' : d.message
  const lines: string[] = [
    `${d.shaShort}  ${truncMessage}`,
    `${d.author} · ${d.date.toLocaleDateString()}`,
    `${d.value.toFixed(2)} ${d.unit}`,
  ]
  if (prev) {
    const delta = d.value - prev.value
    const pct = prev.value === 0 ? 0 : (delta / prev.value) * 100
    const sign = delta >= 0 ? '+' : ''
    lines[lines.length - 1] += `   Δ ${sign}${delta.toFixed(2)} (${sign}${pct.toFixed(2)}%)`
  }
  lines.push('click for details')
  return lines.join('\n')
}

function openDetail(row: Row, prev: Row | undefined, metricName: string): void {
  const dialog = document.getElementById('detail') as HTMLDialogElement | null
  if (!dialog) return
  ;(document.getElementById('detail-title') as HTMLElement).textContent =
    `${row.shaShort}  ${row.message}`
  ;(document.getElementById('detail-meta') as HTMLElement).textContent =
    `${row.author} · ${row.date.toLocaleString()} · ${metricName}`
  const metric = document.getElementById('detail-metric') as HTMLElement
  let deltaHtml = ''
  if (prev) {
    const delta = row.value - prev.value
    const pct = prev.value === 0 ? 0 : (delta / prev.value) * 100
    const cls = pct > 1 ? 'delta-bad' : pct < -1 ? 'delta-good' : ''
    const sign = delta >= 0 ? '+' : ''
    deltaHtml = ` <span class="${cls}">Δ ${sign}${delta.toFixed(2)} ${escapeHtml(row.unit)} (${sign}${pct.toFixed(2)}%)</span>`
  }
  metric.innerHTML = `<span class="value">${row.value.toFixed(2)} ${escapeHtml(row.unit)}</span>${deltaHtml}`
  ;(document.getElementById('detail-extra') as HTMLElement).textContent = row.extra
    ? formatExtra(row.extra)
    : '(no extras)'
  const link = document.getElementById('detail-commit-link') as HTMLAnchorElement
  link.href = safeCommitUrl(row.url)
  link.textContent = `View ${row.shaShort} on GitHub →`
  dialog.showModal()
}

function chart(rows: Row[], metricName: string): HTMLElement {
  const container = document.getElementById('charts')!
  const width = Math.min(container.clientWidth - 40, 1100)
  const unit = state.percent ? '% vs first' : (rows[0]?.unit ?? '')
  const prevByIndex = new Map<number, Row>()
  for (let i = 1; i < rows.length; i++) prevByIndex.set(rows[i]!.i, rows[i - 1]!)
  const plot = Plot.plot({
    width,
    height: 240,
    marginLeft: 60,
    marginBottom: 56,
    marginTop: 20,
    style: {background: 'transparent', color: 'currentColor', fontSize: '12px'},
    y: {
      label: unit,
      grid: true,
      type: state.log && !state.percent ? 'log' : 'linear',
    },
    // Sparse SHA ticks: pick evenly-spaced rows across the visible range
    // and show their short SHA, angled so labels don't collide. Keeps the
    // x-axis informative without turning it into noise.
    x: (() => {
      const target = 16
      const stride = Math.max(1, Math.ceil(rows.length / target))
      const tickIdxs = rows.filter((_, k) => k % stride === 0).map((r) => r.i)
      const shaByIdx = new Map(rows.map((r) => [r.i, r.shaShort]))
      return {
        label: null,
        grid: false,
        ticks: tickIdxs,
        tickFormat: (v: number) => shaByIdx.get(v) ?? '',
        tickRotate: -35,
      }
    })(),
    marks: [
      Plot.ruleY([0], {stroke: 'currentColor', strokeOpacity: 0.15}),
      Plot.line(rows, {x: 'i', y: 'value', stroke: 'var(--accent)', strokeWidth: 1.5}),
      Plot.ruleX(rows, Plot.pointerX({x: 'i', stroke: 'currentColor', strokeOpacity: 0.25})),
      Plot.dot(
        rows,
        Plot.pointerX({
          x: 'i',
          y: 'value',
          r: 5,
          fill: 'var(--accent)',
          stroke: 'var(--card)',
          strokeWidth: 2,
        }),
      ),
      Plot.dot(rows, {
        x: 'i',
        y: 'value',
        r: 3,
        fill: 'var(--accent)',
      }),
      Plot.tip(
        rows,
        Plot.pointerX({
          x: 'i',
          y: 'value',
          title: (d: Row) => tooltipText(d, prevByIndex.get(d.i)),
          fontSize: 11,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fill: 'var(--card)',
          stroke: 'var(--border)',
          textPadding: 8,
        }),
      ),
    ],
  }) as unknown as HTMLElement

  // Click-through: find the nearest row to the click x-coordinate (using
  // Plot's x-scale.apply) and open the detail dialog.
  type ScaleApply = {apply: (v: number) => number} | undefined
  const sx = (plot as unknown as {scale: (n: string) => ScaleApply}).scale('x')
  if (sx) {
    const pxByRow = rows.map((r) => ({row: r, px: sx.apply(r.i)}))
    plot.addEventListener('click', (ev) => {
      const rect = plot.getBoundingClientRect()
      const localX = ev.clientX - rect.left
      let best = pxByRow[0]!
      let bestDist = Math.abs(best.px - localX)
      for (let k = 1; k < pxByRow.length; k++) {
        const d = Math.abs(pxByRow[k]!.px - localX)
        if (d < bestDist) {
          bestDist = d
          best = pxByRow[k]!
        }
      }
      // Ignore clicks that land far from any data point (outside axes, etc.)
      if (bestDist > 40) return
      openDetail(best.row, prevByIndex.get(best.row.i), metricName)
    })
  }

  return plot
}

/** Direction the metric should move to be considered an improvement. Every
 * metric the bench currently emits (memory, bytecode, alloc count, binary
 * size) is smaller-is-better. Centralized here so a future higher-is-better
 * metric (e.g. a throughput counter) only needs an entry in this function. */
function directionFor(_name: string, _unit: string): 'lower' | 'higher' {
  return 'lower'
}

function cardFor(name: string): HTMLElement {
  const raw = seriesFor(name)
  const rows = applyPercent(applyRange(raw))
  const card = document.createElement('div')
  card.className = 'chart-card'
  const last = rows[rows.length - 1]
  const prev = rows[rows.length - 2]
  let delta = ''
  if (last && prev) {
    const d = state.percent
      ? last.value - prev.value
      : ((last.value - prev.value) / (prev.value || 1)) * 100
    const cls = d > 1 ? 'delta-bad' : d < -1 ? 'delta-good' : ''
    delta = `<span class="${cls}">Δ ${d >= 0 ? '+' : ''}${d.toFixed(2)}%</span>`
  }
  const latest = last ? `<span>${last.value.toFixed(2)} ${last.unit}</span>` : ''
  const dir = directionFor(name, last?.unit ?? '')
  const dirHint = `<span class="dir-hint">${dir} is better</span>`
  card.innerHTML = `
    <h3>${escapeHtml(name)} ${dirHint}</h3>
    <div class="meta">${latest}${delta}<span>${rows.length} runs</span></div>
  `
  card.appendChild(chart(rows, name))
  return card
}

function renderCharts(): void {
  const container = document.getElementById('charts')
  if (!container) return
  container.innerHTML = ''
  if (state.selected.size === 0) {
    container.innerHTML = `<div class="empty">Select one or more metrics on the left.</div>`
    return
  }
  const names = [...state.selected]
  if (state.groupByUnit) {
    const byUnit = new Map<string, string[]>()
    for (const n of names) {
      const rows = seriesFor(n)
      const unit = rows[0]?.unit ?? ''
      if (!byUnit.has(unit)) byUnit.set(unit, [])
      byUnit.get(unit)!.push(n)
    }
    for (const [unit, group] of [...byUnit.entries()].sort()) {
      const h = document.createElement('h2')
      h.className = 'unit-heading'
      h.textContent = unit
      container.appendChild(h)
      for (const n of group) container.appendChild(cardFor(n))
    }
  } else {
    for (const n of names) container.appendChild(cardFor(n))
  }
}

function wire(): void {
  const filter = document.getElementById('filter') as HTMLInputElement | null
  filter?.addEventListener('input', (e) => {
    state.filter = (e.target as HTMLInputElement).value
    renderMetricList()
  })
  document.getElementById('selectAll')?.addEventListener('click', () => {
    for (const n of allMetricNames()) state.selected.add(n)
    renderMetricList()
    renderCharts()
  })
  document.getElementById('selectNone')?.addEventListener('click', () => {
    state.selected.clear()
    renderMetricList()
    renderCharts()
  })
  const bind = (id: string, key: 'log' | 'percent' | 'groupByUnit') => {
    const el = document.getElementById(id) as HTMLInputElement | null
    el?.addEventListener('change', (e) => {
      state[key] = (e.target as HTMLInputElement).checked
      renderCharts()
    })
  }
  bind('logScale', 'log')
  bind('percent', 'percent')
  bind('groupByUnit', 'groupByUnit')
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=range]')) {
    r.addEventListener('change', (e) => {
      state.range = (e.target as HTMLInputElement).value as State['range']
      renderCharts()
    })
  }
}

function wireDialog(): void {
  const dialog = document.getElementById('detail') as HTMLDialogElement | null
  if (!dialog) return
  // Close button (inside header).
  dialog.querySelector<HTMLButtonElement>('.detail-close')?.addEventListener('click', () => {
    dialog.close()
  })
  // Click outside content closes — but only a real click-on-backdrop, not a
  // drag-select that started inside the content and ended on the backdrop.
  // We require both pointerdown and the subsequent click to target the dialog
  // element itself; text selection drags have a pointerdown inside a child.
  let pressOnBackdrop = false
  dialog.addEventListener('pointerdown', (ev) => {
    pressOnBackdrop = ev.target === dialog
  })
  dialog.addEventListener('click', (ev) => {
    if (pressOnBackdrop && ev.target === dialog) dialog.close()
    pressOnBackdrop = false
  })
}

async function main(): Promise<void> {
  try {
    await load()
    const names = allMetricNames()
    const defaults = names.filter((n) => n.startsWith('runtime_init'))
    for (const n of defaults.length ? defaults : names.slice(0, 2)) state.selected.add(n)
    renderMetricList()
    renderCharts()
    wire()
    wireDialog()
  } catch (err) {
    const container = document.getElementById('charts')
    if (container) {
      container.innerHTML = `<div class="empty">Failed to load data: ${escapeHtml(String(err))}</div>`
    }
  }
}

void main()
