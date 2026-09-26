#!/usr/bin/env node
// In the Mikro.js repository, run the TypeScript source, so a firmware build
// never runs a stale dist/. A published package has only dist/.
import {existsSync} from 'node:fs'

const src = new URL('../src/cli.ts', import.meta.url)
await import(existsSync(src) ? src.href : '../dist/cli.js')
