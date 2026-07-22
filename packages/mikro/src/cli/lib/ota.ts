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
  return {
    app: parsed.app,
    version: parsed.version,
    firmwareVersion: parsed.firmwareVersion,
    bytecodeVersion: parsed.bytecodeVersion,
  }
}

/** A working tree's git state, as used to derive a unique snapshot version. */
export interface GitSnapshotState {
  /** Short commit hash of HEAD, or null outside a git repo. */
  sha: string | null
  /** Whether the working tree has uncommitted changes. */
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
 */
export function snapshotVersion(base: string, git: GitSnapshotState, now: Date): string {
  const core = stripBuildMetadata(base)
  let suffix: string
  if (git.sha === null) {
    suffix = `snapshot.${compactUtcTimestamp(now)}`
  } else if (git.dirty) {
    suffix = `snapshot.g${git.sha}-dirty.${compactUtcTimestamp(now)}`
  } else {
    suffix = `snapshot.g${git.sha}`
  }
  return core.includes('-') ? `${core}.${suffix}` : `${core}-${suffix}`
}

/**
 * Read the working tree's git state for `snapshotVersion`. A failure (not a git
 * repo, git absent) is the expected "no commit" case, not an error: it resolves
 * to no sha, routing `snapshotVersion` to its timestamp fallback.
 */
export async function resolveGitState(cwd: string): Promise<GitSnapshotState> {
  try {
    const [{stdout: sha}, {stdout: status}] = await Promise.all([
      // Pin the abbreviation length so "same commit -> same version" is stable
      // over time; git's default length grows as the object database does.
      execFileAsync('git', ['rev-parse', '--short=12', 'HEAD'], {cwd, encoding: 'utf-8'}),
      execFileAsync('git', ['status', '--porcelain'], {cwd, encoding: 'utf-8'}),
    ])
    return {sha: sha.trim() || null, dirty: status.trim().length > 0}
  } catch {
    return {sha: null, dirty: false}
  }
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
