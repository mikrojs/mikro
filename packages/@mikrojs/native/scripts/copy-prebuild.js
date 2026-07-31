#!/usr/bin/env node
import {copyFileSync, existsSync, mkdirSync, rmSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(pkgRoot, 'addon', 'build', 'Release', 'mikrojs_node.node')

if (!existsSync(source)) {
  // eslint-disable-next-line no-console
  console.error(`No native binary at ${source}. Run 'cmake-js compile --directory addon' first.`)
  process.exit(1)
}

const targetDir = resolve(pkgRoot, 'prebuilds', `${process.platform}-${process.arch}`)
mkdirSync(targetDir, {recursive: true})
const target = resolve(targetDir, 'mikrojs.napi.node')
// Remove before copying so the target gets a fresh inode. Overwriting in
// place invalidates the macOS code-signature cache and any process that
// dlopens the library afterwards is killed with SIGKILL.
rmSync(target, {force: true})
copyFileSync(source, target)
// eslint-disable-next-line no-console
console.log(`Copied → ${target}`)
