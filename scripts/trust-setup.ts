#!/usr/bin/env node --experimental-strip-types
/* eslint-disable no-console */
// Configure npm trusted publishing for every public workspace package.
// Idempotent: re-running skips packages that already trust this workflow.
import {execFileSync, spawnSync} from 'node:child_process'

const WORKFLOW = 'release.yml'

interface WorkspacePackage {
  name: string
  version: string
  path: string
  private?: boolean
}

type AddResult =
  | {pkg: WorkspacePackage; status: 'added'}
  | {pkg: WorkspacePackage; status: 'skipped'}
  | {pkg: WorkspacePackage; status: 'would-add'}
  | {pkg: WorkspacePackage; status: 'failed'; code: string | null; stderr: string}

const listWorkspacePackages = (): WorkspacePackage[] =>
  JSON.parse(execFileSync('pnpm', ['m', 'ls', '--json', '--depth=-1'], {encoding: 'utf8'}))

const isPublic = (pkg: WorkspacePackage): boolean => !pkg.private

const byName = (a: WorkspacePackage, b: WorkspacePackage): number => a.name.localeCompare(b.name)

const parseErrorCode = (stderr: string): string | null =>
  stderr.match(/^npm error code (E\w+)$/m)?.[1] ?? null

function addTrust(pkg: WorkspacePackage): AddResult {
  const result = spawnSync('npm', ['trust', 'github', '--file', WORKFLOW, '--yes'], {
    cwd: pkg.path,
    stdio: ['inherit', 'inherit', 'pipe'],
    encoding: 'utf8',
  })
  if (result.status === 0) return {pkg, status: 'added'}

  const stderr = result.stderr ?? ''
  const code = parseErrorCode(stderr)
  if (code === 'E409') return {pkg, status: 'skipped'}
  return {pkg, status: 'failed', code, stderr}
}

const dryRun = process.argv.slice(2).includes('--dry-run')

const packages = listWorkspacePackages().filter(isPublic).sort(byName)

console.log(`Found ${packages.length} public package(s)${dryRun ? ' (dry run)' : ''}:`)
packages.forEach((p) => console.log(`  - ${p.name}`))
console.log()

const ICONS: Record<AddResult['status'], string> = {
  added: '+',
  'would-add': '?',
  skipped: '✓',
  failed: '✗',
}

const results: AddResult[] = packages.map((pkg) => {
  const result: AddResult = dryRun ? {pkg, status: 'would-add'} : addTrust(pkg)
  const note = result.status === 'skipped' ? ' (already trusted)' : ''
  console.log(`${ICONS[result.status]} ${pkg.name}${note}`)
  return result
})

const counts = results.reduce<Record<AddResult['status'], number>>(
  (acc, r) => ({...acc, [r.status]: (acc[r.status] ?? 0) + 1}),
  {added: 0, 'would-add': 0, skipped: 0, failed: 0},
)

const failures = results.filter((r): r is AddResult & {status: 'failed'} => r.status === 'failed')
failures.forEach((r) => {
  process.stderr.write(`\n${r.pkg.name} failed${r.code ? ` (${r.code})` : ''}:\n${r.stderr}\n`)
})

if (dryRun) {
  console.log(`\nDry run. Would add: ${counts['would-add']}.`)
} else {
  console.log(
    `\nDone. Added: ${counts.added}, skipped: ${counts.skipped}, failed: ${counts.failed}.`,
  )
}
process.exit(failures.length > 0 ? 1 : 0)
