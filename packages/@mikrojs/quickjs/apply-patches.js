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
import {createHash} from 'node:crypto'
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const qjsDir = join(__dirname, 'deps', 'quickjs')
const patchesDir = join(__dirname, 'patches')

function seriesHash(files) {
  const hash = createHash('sha256')
  for (const f of files) hash.update(readFileSync(join(patchesDir, f)))
  return hash.digest('hex')
}

function applyAll(files) {
  for (const f of files) {
    try {
      execFileSync('git', ['apply', join(patchesDir, f)], {cwd: qjsDir, stdio: 'inherit'})
      console.log(`@mikrojs/quickjs: applied patch ${f}`)
    } catch (err) {
      console.error(`@mikrojs/quickjs: failed to apply ${f}`, err.message)
      process.exit(1)
    }
  }
}

export function applyPatches() {
  // Published tarballs ship pre-patched sources and exclude patches/ from
  // the package files, so consumers return here and never need git.
  if (!existsSync(patchesDir)) return
  const files = readdirSync(patchesDir)
    .filter((f) => f.endsWith('.patch'))
    .sort()
  if (files.length === 0) return

  // Patches may stack (a later patch can modify code an earlier one added),
  // so they are only meaningful as a whole series applied in order to a
  // pristine tree. A stamp records which series the tree currently carries.
  const stampFile = join(qjsDir, '.patches-stamp')
  const hash = seriesHash(files)
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === hash) {
    // The stamp can outlive the tree it describes (e.g. `git submodule
    // update` resets sources but leaves untracked files); trust it only if
    // the series bounds are actually present. First and last together catch
    // both a reset tree and a partially reverted one.
    try {
      for (const probe of [files[0], files[files.length - 1]]) {
        execFileSync('git', ['apply', '--reverse', '--check', join(patchesDir, probe)], {
          cwd: qjsDir,
          stdio: 'pipe',
        })
      }
      return // series already applied
    } catch {
      // stale stamp — fall through and re-apply
    }
  }

  let inRepo = true
  try {
    execFileSync('git', ['-C', qjsDir, 'rev-parse', 'HEAD'], {stdio: 'pipe'})
  } catch {
    inRepo = false
  }

  if (!inRepo) {
    // Sources without git metadata (should not happen: tarballs exclude
    // patches/ and return above). Refuse rather than guess.
    console.error('@mikrojs/quickjs: patches/ present but deps/quickjs is not a git checkout')
    process.exit(1)
  }

  // In-repo: reset to the pinned commit, then apply the whole series.
  // Only reset when the tree state is accounted for (a previous series
  // stamp, a clean tree, or a tree matching the pre-stamp-era series);
  // otherwise refuse rather than discard unknown local edits. Untracked
  // files (editor droppings, agent scratch dirs) are ignored: they cannot
  // conflict with `git apply` of tracked-file patches, and `checkout -- .`
  // could not remove them anyway.
  const dirty =
    execFileSync('git', ['-C', qjsDir, 'status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((l) => l.trim()).length > 0
  if (dirty && !existsSync(stampFile)) {
    // Pre-stamp checkouts have some prefix of the series applied; the
    // first patch reverse-checking is strong evidence of that state.
    try {
      execFileSync('git', ['apply', '--reverse', '--check', join(patchesDir, files[0])], {
        cwd: qjsDir,
        stdio: 'pipe',
      })
    } catch {
      console.error(
        '@mikrojs/quickjs: submodule tree has local changes that do not match the patch series.\n' +
          `Commit them as a patch or discard them: git -C ${qjsDir} checkout -- .`,
      )
      process.exit(1)
    }
  }
  if (dirty) {
    // The tree is about to be discarded and re-derived from the patch
    // series. This also runs from CMake configure, i.e. mid-development
    // when someone is iterating on a patch — keep a backup of whatever
    // tracked changes are thrown away so an unregenerated edit is
    // recoverable instead of silently gone.
    const diff = execFileSync('git', ['-C', qjsDir, 'diff'], {encoding: 'utf8'})
    if (diff.length > 0) {
      const backup = join(tmpdir(), `quickjs-discarded-${Date.now()}.patch`)
      writeFileSync(backup, diff)
      console.log(`@mikrojs/quickjs: re-deriving submodule tree from the patch series`)
      console.log(`@mikrojs/quickjs: previous tracked changes saved to ${backup}`)
    }
    execFileSync('git', ['-C', qjsDir, 'checkout', '--', '.'], {stdio: 'inherit'})
  }
  applyAll(files)
  writeFileSync(stampFile, hash + '\n')
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
