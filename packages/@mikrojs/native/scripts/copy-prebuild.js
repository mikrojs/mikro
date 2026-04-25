#!/usr/bin/env node
import {copyFileSync, existsSync, mkdirSync} from 'node:fs'
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
copyFileSync(source, target)
// eslint-disable-next-line no-console
console.log(`Copied → ${target}`)
