#!/usr/bin/env node --experimental-strip-types
/* eslint-disable no-console */
// Configure npm trusted publishing for every public workspace package so the
// only trusted publisher is REPO + WORKFLOW. Declarative: reads the current
// trust config, diffs against the desired state, prints the planned changes
// (add the desired GitHub relationship where missing, revoke any other / stale
// entries), and asks for confirmation before applying.
//
// Flags: --dry-run (plan only).
import {execFileSync, spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {createInterface} from 'node:readline/promises'
import {Writable} from 'node:stream'
import {fileURLToPath} from 'node:url'

const WORKFLOW = 'release.yml'
// GitHub repo that runs the release workflow. Hardcoded (not derived from the
// git remote, which may still point at the pre-rename slug) so trust binds to
// the correct repo.
const REPO = 'mikrojs/mikro'

// Run the npm pinned in scripts/package.json, resolve its CLI from npm's own manifest bin field.
const npmManifestPath = fileURLToPath(import.meta.resolve('npm/package.json'))
const npmManifest = JSON.parse(readFileSync(npmManifestPath, 'utf8')) as {bin: {npm: string}}
const NPM_CLI = join(dirname(npmManifestPath), npmManifest.bin.npm)

interface WorkspacePackage {
  name: string
  path: string
  private?: boolean
}

interface TrustEntry {
  id: string
  type: string
  file: string
  repository: string
}

interface Plan {
  pkg: WorkspacePackage
  add: boolean
  revoke: TrustEntry[]
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
// Populated from the interactive prompt when npm asks (EOTP); never a CLI arg.
let otp = ''

const listWorkspacePackages = (): WorkspacePackage[] =>
  JSON.parse(execFileSync('pnpm', ['m', 'ls', '--json', '--depth=-1'], {encoding: 'utf8'}))

const isPublic = (pkg: WorkspacePackage): boolean => !pkg.private
const byName = (a: WorkspacePackage, b: WorkspacePackage): number => a.name.localeCompare(b.name)
const isDesired = (e: TrustEntry): boolean =>
  e.type === 'github' && e.file === WORKFLOW && e.repository === REPO

// npm reports the error code on stderr ("npm error code EXXX") and, for --json
// commands, in the body ({"error":{"code":"EXXX"}}). Match both via regex so we
// catch it wherever npm put it (and avoid JSON.parse / try-catch).
const errorCode = (stdout: string, stderr: string): string | null =>
  stderr.match(/^npm error code (E\w+)$/m)?.[1] ?? stdout.match(/"code":\s*"(E\w+)"/)?.[1] ?? null

// Human-readable error (npm's JSON summary, else the first non-code stderr
// line), so failure messages are actionable beyond the bare code.
const errorSummary = (stdout: string, stderr: string): string =>
  stdout.match(/"summary":\s*"([^"]+)"/)?.[1] ??
  stderr.match(/^npm error (?!code\b)(.+)$/m)?.[1] ??
  ''

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ''
  const rl = createInterface({input: process.stdin, output: process.stdout})
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

// Like prompt(), but does not echo typed characters (for OTP entry): write the
// question, then read with a muted output so keystrokes stay hidden.
async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ''
  process.stdout.write(question)
  const muted = new Writable({write: (_chunk, _encoding, cb) => cb()})
  const rl = createInterface({input: process.stdin, output: muted, terminal: true})
  try {
    return (await rl.question('')).trim()
  } finally {
    rl.close()
    process.stdout.write('\n')
  }
}

function parseEntries(stdout: string): TrustEntry[] {
  const parsed = JSON.parse(stdout.trim() || '[]')
  if (Array.isArray(parsed)) return parsed as TrustEntry[]
  return parsed && parsed.id ? [parsed as TrustEntry] : []
}

// Run one `npm trust` command with the current OTP. On EOTP (missing/expired
// code) prompt for a fresh one and retry; any other failure is returned for the
// caller to surface and stop.
async function trust(
  pkg: WorkspacePackage,
  cmd: string[],
): Promise<{ok: boolean; code: string | null; stdout: string; stderr: string}> {
  for (;;) {
    // npm's trust parser only accepts the --otp=<code> form; `--otp <code>` is misread as a positional argument.
    const otpArgs = otp ? [`--otp=${otp}`] : []
    const result = spawnSync(process.execPath, [NPM_CLI, 'trust', ...cmd, ...otpArgs], {
      cwd: pkg.path,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const code = result.status === 0 ? null : errorCode(stdout, stderr)
    if (code !== 'EOTP') return {ok: result.status === 0 && !code, code, stdout, stderr}
    const fresh = await promptHidden(
      'npm one-time password (from your authenticator, blank to abort): ',
    )
    if (!fresh) return {ok: false, code, stdout, stderr}
    otp = fresh
  }
}

const failDetail = (
  verb: string,
  res: {code: string | null; stdout: string; stderr: string},
): string => {
  const summary = errorSummary(res.stdout, res.stderr)
  return `${verb} failed (${res.code ?? '?'}${summary ? `: ${summary}` : ''})`
}

// Print npm's full output (stderr, else stdout) so failures are diagnosable.
const logNpmError = (res: {stdout: string; stderr: string}): void => {
  const text = res.stderr.trim() || res.stdout.trim()
  if (text) console.error(text)
}

async function addTrust(pkg: WorkspacePackage): Promise<{ok: boolean; detail: string}> {
  const res = await trust(pkg, [
    'github',
    `--file=${WORKFLOW}`,
    `--repo=${REPO}`,
    '--allow-publish',
    '--allow-stage-publish',
    '--yes',
  ])
  // E409 = already present (race with a concurrent setup); treat as success.
  if (res.ok || res.code === 'E409') return {ok: true, detail: `added ${REPO}`}
  logNpmError(res)
  return {ok: false, detail: failDetail('add', res)}
}

async function revokeTrust(
  pkg: WorkspacePackage,
  e: TrustEntry,
): Promise<{ok: boolean; detail: string}> {
  const res = await trust(pkg, ['revoke', pkg.name, `--id=${e.id}`])
  if (res.ok) return {ok: true, detail: `revoked ${e.repository}`}
  logNpmError(res)
  return {ok: false, detail: failDetail(`revoke ${e.repository}`, res)}
}

const packages = listWorkspacePackages().filter(isPublic).sort(byName)

// 1. Read current trust config (prompts for OTP) and 2. diff against desired.
console.log(`Desired trusted publisher: github · ${REPO} · ${WORKFLOW}`)
console.log(`Reading current trust config for ${packages.length} package(s)...\n`)

const plans: Plan[] = []
for (const pkg of packages) {
  const res = await trust(pkg, ['list', pkg.name, '--json'])
  // A read failure here (auth) will repeat for every package — stop.
  if (!res.ok) {
    logNpmError(res)
    console.error(`\nCould not read trust config for ${pkg.name}: ${res.code ?? 'failed'}`)
    console.error('Ensure you are logged in (`npm login`) with a TOTP authenticator, then retry.')
    process.exit(1)
  }
  const entries = parseEntries(res.stdout)
  plans.push({pkg, add: !entries.some(isDesired), revoke: entries.filter((e) => !isDesired(e))})
}

const changes = plans.filter((p) => p.add || p.revoke.length > 0)
const addCount = plans.filter((p) => p.add).length
const revokeCount = plans.reduce((n, p) => n + p.revoke.length, 0)
const okCount = packages.length - changes.length

// 3. Summary.
if (changes.length === 0) {
  console.log(`All ${packages.length} package(s) already correct. Nothing to do.`)
  process.exit(0)
}

console.log('Planned changes:')
for (const p of changes) {
  console.log(`  ${p.pkg.name}`)
  for (const e of p.revoke) console.log(`    - revoke ${e.repository} · ${e.file}`)
  if (p.add) console.log(`    + add    ${REPO} · ${WORKFLOW}`)
}
console.log(
  `\n${addCount} add, ${revokeCount} revoke across ${changes.length} package(s); ${okCount} already correct.`,
)

if (dryRun) process.exit(0)

// 4. Confirm, then apply — stopping on the first hard failure.
const yes = ['y', 'yes'].includes((await prompt('\nProceed? [y/N] ')).toLowerCase())
if (!yes) {
  console.log('Aborted. No changes made.')
  process.exit(1)
}

console.log()
const counts = {added: 0, revoked: 0}
for (const p of changes) {
  const parts: string[] = []
  let failed = false
  // npm allows only one trusted publisher per package, so revoke stale entries
  // before adding the desired one (otherwise the add is rejected with E400).
  for (const e of p.revoke) {
    const r = await revokeTrust(p.pkg, e)
    parts.push(r.detail)
    if (r.ok) counts.revoked += 1
    else failed = true
    if (failed) break
  }
  if (!failed && p.add) {
    const r = await addTrust(p.pkg)
    parts.push(r.detail)
    if (r.ok) counts.added += 1
    else failed = true
  }
  console.log(`${failed ? '✗' : '✓'} ${p.pkg.name.padEnd(26)} ${parts.join(', ')}`)
  if (failed) {
    console.error(
      '\nStopped on first failure — an auth / 2FA / permission error will repeat' +
        ' for the rest. Fix it and re-run; completed entries are idempotent.',
    )
    process.exit(1)
  }
}
console.log(`\nDone: ${counts.added} added, ${counts.revoked} revoked.`)
