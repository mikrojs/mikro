#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Apply mikrojs-local QuickJS patches to the submodule working tree.
 *
 * Patches live in patches/*.patch and are applied idempotently: if
 * `git apply --reverse --check` succeeds the patch is already present.
 *
 * Importable (`applyPatches()`) and runnable (`node apply-patches.js`).
 * The release publish job runs it explicitly: that job installs with
 * --ignore-scripts, so the postinstall that normally applies the patch
 * never runs. Without this the packed @mikrojs/quickjs tarball ships
 * unpatched QuickJS source and every consumer fails to compile
 * @mikrojs/native (which calls the patched module-management symbols).
 */
import {execFileSync} from 'node:child_process'
import {existsSync, readdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const qjsDir = join(__dirname, 'deps', 'quickjs')
const patchesDir = join(__dirname, 'patches')

export function applyPatches() {
  if (!existsSync(patchesDir)) return
  const files = readdirSync(patchesDir)
    .filter((f) => f.endsWith('.patch'))
    .sort()
  for (const f of files) {
    const patch = join(patchesDir, f)
    // Probe: is the patch already applied?
    try {
      execFileSync('git', ['apply', '--reverse', '--check', patch], {
        cwd: qjsDir,
        stdio: 'pipe',
      })
      continue // already applied
    } catch {
      // not applied — fall through
    }
    try {
      execFileSync('git', ['apply', patch], {cwd: qjsDir, stdio: 'inherit'})
      console.log(`@mikrojs/quickjs: applied patch ${f}`)
    } catch (err) {
      console.error(`@mikrojs/quickjs: failed to apply ${f}`, err.message)
      process.exit(1)
    }
  }
}

// Run directly: sync the submodule, then apply patches.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = join(__dirname, '..', '..', '..')
  try {
    execFileSync(
      'git',
      ['submodule', 'update', '--init', 'packages/@mikrojs/quickjs/deps/quickjs'],
      {
        cwd: repoRoot,
        stdio: 'inherit',
      },
    )
  } catch {
    if (!existsSync(join(qjsDir, 'quickjs.c'))) {
      console.error(
        '@mikrojs/quickjs: Failed to initialize QuickJS submodule.\n' +
          'Run manually: git submodule update --init packages/@mikrojs/quickjs/deps/quickjs',
      )
      process.exit(1)
    }
  }
  applyPatches()
}
