#!/usr/bin/env -S node --experimental-strip-types
import {copyFileSync, mkdirSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {build} from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = resolve(root, 'dist')

mkdirSync(outDir, {recursive: true})

await build({
  entryPoints: [resolve(here, 'app.ts')],
  outfile: resolve(outDir, 'bench.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  logLevel: 'info',
})

copyFileSync(resolve(here, 'index.html'), resolve(outDir, 'index.html'))
copyFileSync(resolve(here, 'bench.css'), resolve(outDir, 'bench.css'))

console.log(`built ${outDir}`)
