import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import * as pathlib from 'node:path'
import {promisify} from 'node:util'

import {createReadStream} from 'fs'
import {readdir, readFile, rm, stat, writeFile} from 'fs/promises'
import {create as tarCreate} from 'tar'

const execFileAsync = promisify(execFile)

/** Manifest written to the build root as `mikro.app.json`. The firmware and
 * the registry read it to decide whether a device can load the build. */
export interface OtaManifest {
  /** Application lineage (the project's `package.json` name). The registry
   * scopes `auto` updates by app, so a publishable build must name one. */
  app: string
  /** App version (the project's `package.json` version). A release on the
   * registry is the set of builds sharing app + version. */
  version: string
  /** Minimum firmware version the build requires (the project's resolved
   * `@mikrojs/firmware` version). */
  firmwareVersion: string
  /** QuickJS bytecode version the build was compiled for (byte 0 of a `.bjs`). */
  bytecodeVersion: number
  /** Browsable https URL of the source repository (from the project's
   * `package.json` `repository`), so the registry can link a build back to its
   * source. Absent when `package.json` has no usable repository field. */
  repository?: string
  /** Path of the app within `repository` (from `package.json`'s
   * `repository.directory`), so a workspace links to the app rather than the
   * repo root. Only set alongside `repository`. */
  directory?: string
  /** Full commit SHA of HEAD at pack time, like npm's `gitHead`. In the manifest
   * rather than read at push time because nothing else can recover it: a
   * `push --tarball` from another machine has only these bytes, and reading the
   * pusher's HEAD would name an unrelated commit. Absent outside a git repo. */
  commit?: string
  /** True when the repository had uncommitted changes at pack time. Says the
   * build may not match `commit`, not that it does not: the check is
   * repository-wide, so an edit to a file outside this app also sets it.
   * Omitted (reads as false) for a clean tree. */
  dirty?: boolean
}

export const MANIFEST_NAME = 'mikro.app.json'

/**
 * Resolve the concrete installed version of the project's `@mikrojs/firmware`
 * dependency. Tries a direct resolve from the project root first, then falls
 * back to resolving it through the `mikro` package (which depends on
 * `@mikrojs/firmware` in lockstep), covering projects that depend on `mikro`
 * without listing the firmware package directly.
 */
function resolveFirmwarePkgPath(req: NodeJS.Require): string | null {
  try {
    return req.resolve('@mikrojs/firmware/package.json')
  } catch {
    try {
      const fromMikro = createRequire(req.resolve('mikro/package.json'))
      return fromMikro.resolve('@mikrojs/firmware/package.json')
    } catch {
      return null
    }
  }
}

export async function resolveFirmwareVersion(projectRoot: string): Promise<string> {
  const fromProject = createRequire(pathlib.join(projectRoot, 'noop.js'))
  const pkgPath = resolveFirmwarePkgPath(fromProject)
  if (pkgPath === null) {
    throw new Error(
      'Could not resolve @mikrojs/firmware. Install it (or the mikro package) in this project.',
    )
  }
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as {version?: string}
  if (typeof pkg.version !== 'string') {
    throw new Error(`@mikrojs/firmware package.json at ${pkgPath} has no version`)
  }
  return pkg.version
}

async function findFirstBjs(dir: string): Promise<string | null> {
  const entries = await readdir(dir, {withFileTypes: true})
  // Files before directories so a top-level `.bjs` wins without recursing.
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.bjs')) {
      return pathlib.join(dir, entry.name)
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findFirstBjs(pathlib.join(dir, entry.name))
      if (found !== null) return found
    }
  }
  return null
}

/**
 * Read the QuickJS bytecode version from the compiled output. The first byte
 * of any `.bjs` file is the bytecode version, the same byte the firmware reads
 * as `bc_version`.
 */
export async function readBytecodeVersion(buildDir: string): Promise<number> {
  const bjs = await findFirstBjs(buildDir)
  if (bjs === null) {
    throw new Error(`No .bjs files found in ${buildDir}; build did not produce bytecode`)
  }
  const fd = await readFile(bjs)
  if (fd.length === 0) {
    throw new Error(`Compiled bytecode file is empty: ${bjs}`)
  }
  return fd[0]!
}

/** Recursively remove macOS AppleDouble sidecars (`._*`) and `.DS_Store`. */
export async function pruneMacSidecars(dir: string): Promise<void> {
  const entries = await readdir(dir, {withFileTypes: true})
  for (const entry of entries) {
    const full = pathlib.join(dir, entry.name)
    if (entry.name === '.DS_Store' || entry.name.startsWith('._')) {
      await rm(full, {force: true, recursive: true})
      continue
    }
    if (entry.isDirectory()) {
      await pruneMacSidecars(full)
    }
  }
}

export async function writeManifest(buildDir: string, manifest: OtaManifest): Promise<void> {
  await writeFile(pathlib.join(buildDir, MANIFEST_NAME), JSON.stringify(manifest))
}

/** Every path under `root`, `root`-relative, each directory immediately before
 * its contents. Sorted by code unit rather than `localeCompare`, which varies
 * with the machine's locale and would defeat the point. */
async function walkSorted(root: string, rel = ''): Promise<string[]> {
  const entries = await readdir(rel === '' ? root : pathlib.join(root, rel), {withFileTypes: true})
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const out: string[] = []
  for (const entry of entries) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`
    out.push(path)
    if (entry.isDirectory()) out.push(...(await walkSorted(root, path)))
  }
  return out
}

/**
 * Pack the contents of `buildDir` into a gzipped tar at `outPath`. Members keep
 * their `buildDir`-relative paths (so a standard project yields `app/...` plus
 * `mikro.app.json` at the root). macOS sidecars are pruned beforehand.
 *
 * The output is byte-for-byte reproducible from identical input, because the
 * build checksum is a SHA-256 over this file: two packs of the same tree have to
 * hash the same or the checksum identifies an archive rather than a build, and
 * dedupe, resumption, and "am I already running this?" all stop working. That
 * needs every source of ambient variation pinned:
 *
 *   - `noMtime` — otherwise each member carries the time it was written.
 *   - `portable` — drops uid/gid/uname/gname/dev/ino/nlink, normalises mode, and
 *     pins the gzip header's OS byte, so neither the packing user and umask nor
 *     the packing platform reaches the archive. (The gzip header's own timestamp
 *     is already zero: node's zlib never sets it.)
 *   - `noDirRecurse` plus an explicitly sorted entry list — the walker's own
 *     order is readdir order, which is filesystem-dependent.
 *
 * Not covered: a filename's Unicode normalisation is whatever the filesystem
 * hands back, so a build packed on macOS (NFD) and on Linux (NFC) can still
 * differ. That needs a normalising step at file creation, not here.
 *
 * Reproducible from identical *input*, which since the manifest carries the
 * source commit and dirty flag includes the git state: the same tree packed at
 * two different commits hashes differently. Deliberate — the commit has to
 * travel inside the artifact to survive a `pack` and `push --tarball` in
 * separate CI stages — but it means re-pushing one version from a moved HEAD is
 * a checksum conflict, not an idempotent no-op.
 */
export async function createTarball(buildDir: string, outPath: string): Promise<void> {
  await pruneMacSidecars(buildDir)
  const entries = await walkSorted(buildDir)
  if (entries.length === 0) {
    throw new Error(`Nothing to pack: ${buildDir} is empty`)
  }
  await tarCreate(
    {
      file: outPath,
      cwd: buildDir,
      gzip: {level: 9},
      portable: true,
      noMtime: true,
      noDirRecurse: true,
    },
    entries,
  )
}

/** Read and parse the `mikro.app.json` manifest from a packed `.tgz`. */
export async function readManifestFromTarball(tarballPath: string): Promise<OtaManifest> {
  const {stdout} = await execFileAsync('tar', ['-xzOf', tarballPath, MANIFEST_NAME], {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  })
  const parsed = JSON.parse(stdout) as Partial<OtaManifest>
  if (
    typeof parsed.app !== 'string' ||
    parsed.app.length === 0 ||
    typeof parsed.version !== 'string' ||
    parsed.version.length === 0 ||
    typeof parsed.firmwareVersion !== 'string' ||
    typeof parsed.bytecodeVersion !== 'number'
  ) {
    throw new Error(
      `${tarballPath} does not contain a valid ${MANIFEST_NAME} (packed with an older CLI? re-run 'mikro ota pack')`,
    )
  }
  const manifest: OtaManifest = {
    app: parsed.app,
    version: parsed.version,
    firmwareVersion: parsed.firmwareVersion,
    bytecodeVersion: parsed.bytecodeVersion,
  }
  // Source fields are optional and only present on builds packed by a newer CLI.
  if (typeof parsed.repository === 'string') manifest.repository = parsed.repository
  if (typeof parsed.directory === 'string') manifest.directory = parsed.directory
  if (typeof parsed.commit === 'string') manifest.commit = parsed.commit
  if (parsed.dirty === true) manifest.dirty = true
  return manifest
}

/** A working tree's git state: the source of both the snapshot version and the
 *  manifest's source fields. */
export interface GitSnapshotState {
  /** Full commit hash of HEAD, or null outside a git repo. */
  sha: string | null
  /** Whether the repository has uncommitted changes. Repository-wide, not
   *  scoped to the packed project: in a workspace, an edit to a sibling package
   *  counts, since it may well be a build input. */
  dirty: boolean
}

/** `YYYYMMDDTHHmmssZ` in UTC. A valid semver prerelease identifier: the `T`/`Z`
 *  keep it alphanumeric, so it dodges the leading-zero rule that would reject an
 *  all-digit identifier. */
function compactUtcTimestamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
  )
}

/** How much of the sha the snapshot version carries. Pinned rather than left to
 *  git's own abbreviation, which grows as the object database does. */
const SHORT_SHA_LENGTH = 12

/** Drop any `+build` metadata from a version. Appended prerelease identifiers
 *  must precede build metadata in semver order, so a stray `+…` on the base
 *  would make the derived string invalid. A `package.json` version never carries
 *  it, but strip defensively. */
function stripBuildMetadata(version: string): string {
  const plus = version.indexOf('+')
  return plus === -1 ? version : version.slice(0, plus)
}

/**
 * Derive a unique OTA version for `--snapshot`, so dev iteration does not need a
 * manual `package.json` bump. The registry keys build immutability on
 * `(app, version, bytecodeVersion)`, so each iteration needs a distinct version.
 *
 * Uniqueness rides in a semver **prerelease**, not build metadata: build
 * metadata is ignored in semver equality (`1.2.3+a` equals `1.2.3+b`), so a
 * conformant registry would collapse two snapshots into one. A prerelease is
 * always significant.
 *
 *   clean    `<base>-snapshot.g<sha>`             commit fully identifies it, so
 *                                                 re-publishing a commit is idempotent
 *   dirty    `<base>-snapshot.g<sha>-dirty.<ts>`  `g<sha>-dirty` is the `git describe`
 *                                                 idiom; the timestamp makes repeated
 *                                                 builds of an ephemeral tree distinct
 *   no git   `<base>-snapshot.<ts>`               no commit to name
 *
 * The `g` prefix keeps the sha identifier alphanumeric (an all-digit sha with a
 * leading zero would be an invalid numeric identifier). A base that already has
 * a prerelease is extended with `.`; a plain base opens one with `-`.
 *
 * The sha is abbreviated here rather than by git, at a pinned length, so "same
 * commit -> same version" stays stable: git's own abbreviation grows as the
 * object database does.
 */
export function snapshotVersion(base: string, git: GitSnapshotState, now: Date): string {
  const core = stripBuildMetadata(base)
  const short = git.sha?.slice(0, SHORT_SHA_LENGTH)
  let suffix: string
  if (short === undefined) {
    suffix = `snapshot.${compactUtcTimestamp(now)}`
  } else if (git.dirty) {
    suffix = `snapshot.g${short}-dirty.${compactUtcTimestamp(now)}`
  } else {
    suffix = `snapshot.g${short}`
  }
  return core.includes('-') ? `${core}.${suffix}` : `${core}-${suffix}`
}

/**
 * Read the repository's git state: the full sha, as the manifest's durable
 * record of what a build came from (the way npm records `gitHead`), abbreviated
 * by `snapshotVersion` for the version string. Read once per pack so the two
 * cannot disagree about whether the tree was dirty.
 *
 * A failure (not a git repo, git absent) is the expected "no commit" case, not
 * an error: it resolves to no sha, routing `snapshotVersion` to its timestamp
 * fallback and leaving the manifest's source fields unset.
 */
export async function resolveGitState(cwd: string): Promise<GitSnapshotState> {
  try {
    const [{stdout: sha}, {stdout: status}] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], {cwd, encoding: 'utf-8'}),
      execFileAsync('git', ['status', '--porcelain'], {cwd, encoding: 'utf-8'}),
    ])
    return {sha: sha.trim() || null, dirty: status.trim().length > 0}
  } catch {
    return {sha: null, dirty: false}
  }
}

/**
 * Normalise a `package.json` `repository` value into a browsable https URL, or
 * `undefined` when it cannot be resolved to one. Covers the common cases npm's
 * hosted-git-info handles, without the dependency: string or object form, host
 * shorthands (`github:o/r`, a bare `o/r`), `git+`/`.git` decoration, and ssh/git
 * remotes rewritten to https. The registry links back to the source with this,
 * so an unparseable value is dropped rather than guessed at.
 */
export function normalizeRepositoryUrl(
  repository: string | {url?: string} | undefined,
): string | undefined {
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  let s = raw.trim()

  // Host shorthands: `github:o/r`, `gitlab:o/r`, `bitbucket:o/r`, or a bare
  // `owner/repo` (npm resolves a bare shorthand to GitHub).
  const hosts: Record<string, string> = {
    github: 'github.com',
    gitlab: 'gitlab.com',
    bitbucket: 'bitbucket.org',
  }
  const shorthand = /^(github|gitlab|bitbucket):(.+)$/.exec(s)
  if (shorthand) s = `https://${hosts[shorthand[1]!]}/${shorthand[2]}`
  else if (/^[\w.-]+\/[\w.-]+$/.test(s)) s = `https://github.com/${s}`

  s = s.replace(/^git\+/, '') // git+https://… → https://…

  // scp-style ssh remote: git@github.com:o/r(.git) → https://github.com/o/r
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(s)
  if (scp) s = `https://${scp[1]}/${scp[2]}`

  s = s.replace(/^git:\/\//i, 'https://').replace(/^ssh:\/\/(?:[^@/]+@)?/i, 'https://')
  // A `#committish` is npm dependency syntax, not part of a browsable url, and
  // the commit is recorded separately anyway. Strip it before `.git`, which
  // would otherwise stay glued to the fragment.
  s = s.replace(/#.*$/, '')
  s = s.replace(/\.git$/, '').replace(/\/+$/, '')

  // Parse rather than regex-test the result: it normalises the scheme and host
  // case, and it is the only way to drop userinfo. A tokenised remote
  // (`https://x-access-token:<token>@github.com/…`) is a plausible thing to find
  // in a CI checkout's package.json, and this url is uploaded to the registry
  // and shown to whoever can read it.
  const url = URL.parse(s)
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) return undefined
  url.username = ''
  url.password = ''
  return url.href.replace(/\/+$/, '')
}

/**
 * Normalise `package.json`'s `repository.directory` (the app's path inside the
 * repository) to a plain relative path, or `undefined` when it is absent or is
 * not one. Leading `./` and stray slashes are trimmed, since a path anchored at
 * the repo root is what was meant either way. A registry composes the result
 * onto the repository URL, so anything that would escape or malform that link —
 * a `..` segment, a Windows separator, a space — is dropped rather than fixed up.
 */
export function normalizeRepositoryDirectory(
  repository: string | {directory?: string} | undefined,
): string | undefined {
  const raw = typeof repository === 'object' ? repository.directory : undefined
  if (typeof raw !== 'string') return undefined
  const path = raw
    .trim()
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
  if (path === '') return undefined
  const segments = path.split('/')
  if (segments.some((s) => s === '.' || s === '..' || !/^[\w.-]+$/.test(s))) return undefined
  return path
}

/** SHA-256 of a file as lowercase hex. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export interface PackArtifact {
  /** Absolute or cwd-relative path to the produced `.tgz`. */
  outPath: string
  /** SHA-256 of the `.tgz`, lowercase hex. */
  checksum: string
  /** Size of the `.tgz` in bytes. */
  size: number
  manifest: OtaManifest
}

/**
 * Finalize a build from an already-built tree: write the manifest, tar it,
 * and compute the checksum and size. The caller is responsible for producing
 * the bytecode build tree in `buildDir` first.
 */
export async function finalizeBuild(
  buildDir: string,
  outPath: string,
  manifest: OtaManifest,
): Promise<PackArtifact> {
  await writeManifest(buildDir, manifest)
  await createTarball(buildDir, outPath)
  const [checksum, info] = await Promise.all([sha256File(outPath), stat(outPath)])
  return {outPath, checksum, size: info.size, manifest}
}
