/* eslint-disable no-console */
import {execSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readdirSync, symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {scaffold, TEMPLATES} from './scaffold.js'

const tempDir = mkdtempSync(path.join(tmpdir(), 'create-mikro-inspect-'))
const templateNames = TEMPLATES.map((t) => t.name)
const templatesDir = path.join(import.meta.dirname!, 'templates')

// Parse args
const args = process.argv.slice(2).filter((a) => a !== '--')
let template: string | undefined
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '-t' || args[i] === '--template') && args[i + 1]) {
    template = args[++i]
  }
}

if (!template || !(templateNames as string[]).includes(template)) {
  console.error(`Usage: pnpm inspect -- -t <template>`)
  console.error(`Templates: ${templateNames.join(', ')}`)
  process.exit(1)
}

const projectDir = path.join(tempDir, 'my-project')

scaffold({
  targetDir: projectDir,
  template,
  projectName: 'my-project',
  mikroVersion: '0.0.0',
  templatesDir,
  pkgManager: 'npm',
})

// Symlink workspace mikro package so the CLI is available
const mikroPkgDir = path.resolve(import.meta.dirname!, '..', '..', 'mikro')
const nodeModules = path.join(projectDir, 'node_modules')
const binDir = path.join(nodeModules, '.bin')
mkdirSync(binDir, {recursive: true})
symlinkSync(mikroPkgDir, path.join(nodeModules, 'mikro'))
symlinkSync(path.join(mikroPkgDir, 'bin', 'mikrojs.js'), path.join(binDir, 'mikro'))

console.log(`\nScaffolded "${template}" into ${projectDir}`)

// List files (skip node_modules)
const files = (readdirSync(projectDir, {recursive: true, withFileTypes: false}) as string[]).filter(
  (f) => !f.startsWith('node_modules'),
)
for (const f of files) {
  console.log(`  ${f}`)
}

console.log(`\nDropping you into ${projectDir}`)
console.log(`Exit the shell to clean up.\n`)

try {
  execSync(`${process.env.SHELL || 'bash'}`, {stdio: 'inherit', cwd: projectDir})
} finally {
  execSync(`rm -rf ${tempDir}`)
  console.log(`Cleaned up ${tempDir}`)
}
