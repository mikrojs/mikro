#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Release gate: assert every symbol the mikrojs QuickJS patches add to
 * quickjs.h is present in the (post-patch) header that will be packed.
 *
 * Catches the failure mode where the publish job ships unpatched QuickJS
 * source (e.g. the apply step was skipped under --ignore-scripts), which
 * makes @mikrojs/native fail to compile in every consumer. Run after
 * apply-patches.js and before publishing.
 */
import {readdirSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const qjsHeader = join(__dirname, 'deps', 'quickjs', 'quickjs.h')
const patchesDir = join(__dirname, 'patches')

// Collect the symbols the patches add to quickjs.h: added (+) lines that
// declare a JS_EXTERN function. Captures the function-name token before '('.
const wanted = new Set()
for (const f of readdirSync(patchesDir)
  .filter((name) => name.endsWith('.patch'))
  .sort()) {
  const patch = readFileSync(join(patchesDir, f), 'utf8')
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+')) continue
    const match = line.match(/^\+\s*JS_EXTERN\b.*?\b(JS_[A-Za-z0-9_]+)\s*\(/)
    if (match) wanted.add(match[1])
  }
}

if (wanted.size === 0) {
  console.error('verify-patches: no JS_EXTERN symbols found in patches/ — patch format changed?')
  process.exit(1)
}

const header = readFileSync(qjsHeader, 'utf8')
const missing = [...wanted].filter(
  (sym) => !new RegExp(`\\bJS_EXTERN\\b.*\\b${sym}\\b`).test(header),
)

if (missing.length) {
  console.error(
    `verify-patches: quickjs.h is missing patched symbols: ${missing.join(', ')}\n` +
      'The QuickJS patches were not applied before packing. Run ' +
      '`node packages/@mikrojs/quickjs/apply-patches.js` before publishing.',
  )
  process.exit(1)
}

console.log(`verify-patches: OK — ${wanted.size} patched symbol(s) present in quickjs.h`)
