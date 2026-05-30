#!/usr/bin/env -S node --experimental-strip-types
// Local dev server: watches src/ with esbuild, serves dist/, and fetches the
// live data.js from the bench-data branch on demand so you can iterate on the
// UI against real history. Override the data source with --data-url <url> or
// --data-file <path>.

import {copyFileSync, existsSync, mkdirSync, readFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {dirname, extname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {context} from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = resolve(root, 'dist')

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const port = parseInt(arg('port', '5178')!, 10)
const dataUrl = arg(
  'data-url',
  'https://raw.githubusercontent.com/mikrojs/mikro/bench-data/dev/bench/data.js',
)!
const dataFile = arg('data-file')

mkdirSync(outDir, {recursive: true})
copyFileSync(resolve(here, 'index.html'), resolve(outDir, 'index.html'))
copyFileSync(resolve(here, 'bench.css'), resolve(outDir, 'bench.css'))

const ctx = await context({
  entryPoints: [resolve(here, 'app.ts')],
  outfile: resolve(outDir, 'bench.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: 'inline',
  logLevel: 'info',
})
await ctx.watch()

let cachedData: string | null = null
async function getData(): Promise<string> {
  if (dataFile) return readFileSync(resolve(process.cwd(), dataFile), 'utf8')
  if (cachedData) return cachedData
  const res = await fetch(dataUrl)
  if (!res.ok) throw new Error(`fetch ${dataUrl}: HTTP ${res.status}`)
  cachedData = await res.text()
  return cachedData
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)
    let pathname = url.pathname
    if (pathname === '/') pathname = '/index.html'
    if (pathname === '/data.js') {
      const body = await getData()
      res.writeHead(200, {'content-type': mime['.js']!, 'cache-control': 'no-store'})
      res.end(body)
      return
    }
    const file = join(outDir, pathname)
    if (!existsSync(file)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const type = mime[extname(file)] ?? 'application/octet-stream'
    res.writeHead(200, {'content-type': type, 'cache-control': 'no-store'})
    res.end(readFileSync(file))
  } catch (err) {
    res.writeHead(500)
    res.end(String(err))
  }
})

server.listen(port, () => {
  console.log(`bench-site dev server: http://localhost:${port}/`)
  if (dataFile) console.log(`data: ${dataFile}`)
  else console.log(`data: ${dataUrl}`)
})
