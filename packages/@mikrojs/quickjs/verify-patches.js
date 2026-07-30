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
import {execFileSync} from 'node:child_process'
import {copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
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

// The symbol grep only sees patches that add JS_EXTERN declarations; a
// behavior-only patch (e.g. 0003, which changes GC internals) would be
// invisible to it. Prove every patch is applied by reverse-applying the
// whole series, in reverse order, on a scratch copy of the patched files.
// Reversing in order handles stacked patches (a later patch may rewrite
// code an earlier one added), which per-patch reverse *checks* cannot.
const patchFiles = readdirSync(patchesDir)
  .filter((name) => name.endsWith('.patch'))
  .sort()
const touched = new Set()
for (const f of patchFiles) {
  for (const line of readFileSync(join(patchesDir, f), 'utf8').split('\n')) {
    const m = line.match(/^--- a\/(.+)$/)
    if (m) touched.add(m[1])
  }
}
const scratch = mkdtempSync(join(tmpdir(), 'verify-patches-'))
try {
  for (const rel of touched) {
    mkdirSync(dirname(join(scratch, rel)), {recursive: true})
    copyFileSync(join(__dirname, 'deps', 'quickjs', rel), join(scratch, rel))
  }
  for (const f of [...patchFiles].reverse()) {
    try {
      execFileSync('git', ['apply', '--reverse', join(patchesDir, f)], {
        cwd: scratch,
        stdio: 'pipe',
      })
    } catch {
      console.error(
        `verify-patches: patch ${f} is not applied in the packed sources.\n` +
          'Run `node packages/@mikrojs/quickjs/apply-patches.js` before publishing.',
      )
      process.exit(1)
    }
  }
} finally {
  rmSync(scratch, {recursive: true, force: true})
}

console.log(
  `verify-patches: OK — ${wanted.size} patched symbol(s) present, ` +
    `${patchFiles.length} patch(es) verified applied`,
)
