import {execFile} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {pipeline} from 'node:stream/promises'
import {promisify} from 'node:util'

import {archiveName, boardFileName, isArchiveForChip} from '@mikrojs/firmware/boards'

import {paths} from './envPaths.js'
import {UserError} from './errorMessage.js'

const execFileAsync = promisify(execFile)

const GITHUB_REPO = 'mikrojs/mikro'
const CACHE_DIR = path.join(paths.cache, 'firmware')

/** Chip identifier (e.g. "esp32c3", "esp32c6"). Not hardcoded — any chip with a matching firmware release asset will work. */
export type Chip = string

export type ResolveFromOptions = {
  from: string
  chip?: Chip
  board?: string
  onProgress?: (message: string) => void
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The archive names to look for, best first, without `.tar.gz`: the
 * `mikro-fw-` names `mikro fw pack` and releases use (see archiveName), then
 * the `mikrojs-firmware-<board>` and `mikrojs-firmware-<chip>` names of older
 * releases and builds.
 */
function archiveCandidates(chip: Chip | undefined, board: string | undefined): string[] {
  const names: string[] = []
  if (board !== undefined && chip !== undefined) names.push(archiveName(board, chip))
  if (board !== undefined) names.push(`mikrojs-firmware-${boardFileName(board)}`)
  if (chip !== undefined) names.push(archiveName(undefined, chip), `mikrojs-firmware-${chip}`)
  return names
}

/** Returns true if the version string looks like a release tag (starts with "v" followed by a digit). */
function isReleaseTag(version: string): boolean {
  return /^v\d/.test(version)
}

async function getGitHubToken(): Promise<string | undefined> {
  // Check environment variable first
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN
  }

  // Try gh CLI auth
  try {
    const {stdout} = await execFileAsync('gh', ['auth', 'token'])
    const token = stdout.trim()
    if (token) return token
  } catch {
    // gh not installed or not authenticated
  }

  return undefined
}

function requireGitHubToken(token: string | undefined): string {
  if (!token) {
    throw new UserError(
      `Authentication required to download firmware.\n` +
        `Run \`gh auth login\` or set the GITHUB_TOKEN environment variable.`,
    )
  }
  return token
}

async function downloadUrl(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, {redirect: 'follow'})
  if (!res.ok || !res.body) {
    if (res.body) await res.text()
    throw new UserError(`Failed to download ${url}: ${res.status} ${res.statusText}`)
  }
  await fs.mkdir(path.dirname(destPath), {recursive: true})
  const fileStream = createWriteStream(destPath)
  await pipeline(res.body, fileStream)
}

// ── GitHub API ───────────────────────────────────────────────────────────────

async function resolveRefToSha(token: string, repo: string, ref: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  })

  if (!res.ok) {
    await res.text()
    if (res.status === 404 || res.status === 422) {
      throw new UserError(`Ref '${ref}' not found in ${repo}.`)
    }
    throw new UserError(`GitHub API error: ${res.status} ${res.statusText}`)
  }

  const commit = (await res.json()) as {sha: string}
  return commit.sha
}

export type ReleaseAsset = {name: string; url: string}

async function fetchRelease(
  token: string,
  repo: string,
  tag?: string,
): Promise<{assets: ReleaseAsset[]}> {
  const url = tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${tag}`
    : `https://api.github.com/repos/${repo}/releases/latest`

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  })

  if (!res.ok) {
    await res.text()
    if (res.status === 404) {
      throw new UserError(
        tag ? `No release '${tag}' found in ${repo}.` : `No releases found in ${repo}.`,
      )
    }
    throw new UserError(`GitHub API error: ${res.status} ${res.statusText}`)
  }

  return (await res.json()) as {assets: ReleaseAsset[]}
}

export function selectReleaseAsset(
  assets: ReleaseAsset[],
  chip: Chip | undefined,
  board: string | undefined,
  repo: string,
): ReleaseAsset {
  for (const name of archiveCandidates(chip, board)) {
    const asset = assets.find((a) => a.name === `${name}.tar.gz`)
    if (asset) return asset
  }
  const archives = assets.filter(
    (a) =>
      a.name.endsWith('.tar.gz') && (a.name.startsWith('mikro-fw-') || a.name.includes('firmware')),
  )
  if (chip !== undefined) {
    const forChip = archives.filter((a) =>
      isArchiveForChip(a.name.slice(0, -'.tar.gz'.length), chip),
    )
    if (forChip.length === 1) return forChip[0]!
  }

  // Auto: single firmware archive
  const firmwareAssets = archives
  if (firmwareAssets.length === 1) return firmwareAssets[0]!

  if (firmwareAssets.length === 0) {
    throw new UserError(
      `No firmware assets found in ${repo} release.\n` +
        `Available assets: ${assets.map((a) => a.name).join(', ') || 'none'}`,
    )
  }

  throw new UserError(
    `Multiple firmware assets found in ${repo} release. Use --target or --board to select one:\n` +
      firmwareAssets.map((a) => `  ${a.name}`).join('\n'),
  )
}

export type WorkflowArtifact = {id: number; name: string; expired: boolean}

async function fetchWorkflowArtifacts(
  token: string,
  repo: string,
  sha: string,
): Promise<WorkflowArtifact[]> {
  // Find all successful workflow runs for this SHA (any workflow). Firmware
  // artifacts may come from `firmware.yml` (PR/dispatch builds, tarball pack)
  // or `release.yml` (release commits, unpacked pack) — we accept both.
  const runsUrl = `https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&status=success&per_page=100`
  const runsRes = await fetch(runsUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  })

  if (!runsRes.ok) {
    await runsRes.text()
    throw new UserError(`GitHub API error: ${runsRes.status} ${runsRes.statusText}`)
  }

  const runs = (await runsRes.json()) as {
    total_count: number
    workflow_runs: {id: number}[]
  }

  if (runs.workflow_runs.length === 0) {
    throw new UserError(
      `No successful workflow runs found for commit ${sha.slice(0, 8)} in ${repo}.\n` +
        `The build may have failed, not been triggered, or the artifact may have expired.`,
    )
  }

  const artifactArrays = await Promise.all(
    runs.workflow_runs.map(async (run) => {
      const url = `https://api.github.com/repos/${repo}/actions/runs/${run.id}/artifacts`
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      })
      if (!res.ok) {
        await res.text()
        return []
      }
      const data = (await res.json()) as {artifacts: WorkflowArtifact[]}
      return data.artifacts
    }),
  )

  return artifactArrays.flat()
}

// Artifact names produced by firmware-build.yml: the archive name (tarball
// pack, used by firmware.yml; `mikrojs-firmware-<x>` in older builds) or
// `firmware-<x>` (unpacked pack, used by release.yml). We accept each.
function isFirmwareArtifact(name: string): boolean {
  return /^(mikro-fw-|(mikrojs-)?firmware(-|$))/.test(name)
}

export function selectWorkflowArtifact(
  artifacts: WorkflowArtifact[],
  chip: Chip | undefined,
  board: string | undefined,
  repo: string,
): WorkflowArtifact {
  for (const name of archiveCandidates(chip, board)) {
    const unpacked = name.replace(/^mikrojs-firmware-/, 'firmware-')
    const artifact = artifacts.find((a) => a.name === name || a.name === unpacked)
    if (artifact) return artifact
  }
  if (chip !== undefined) {
    const forChip = artifacts.filter((a) => isArchiveForChip(a.name, chip))
    if (forChip.length === 1) return forChip[0]!
  }

  // Auto: single firmware artifact
  const firmwareArtifacts = artifacts.filter((a) => isFirmwareArtifact(a.name))
  if (firmwareArtifacts.length === 1) return firmwareArtifacts[0]!

  if (firmwareArtifacts.length === 0) {
    throw new UserError(
      `No firmware artifacts found in ${repo} build.\n` +
        `Available artifacts: ${artifacts.map((a) => a.name).join(', ') || 'none'}`,
    )
  }

  throw new UserError(
    `Multiple firmware artifacts found in ${repo} build. Use --target or --board to select one:\n` +
      firmwareArtifacts.map((a) => `  ${a.name}`).join('\n'),
  )
}

// ── Download & extract ───────────────────────────────────────────────────────

async function downloadAndExtractReleaseAsset(
  token: string,
  asset: ReleaseAsset,
  extractedDir: string,
): Promise<void> {
  const archivePath = path.join(CACHE_DIR, asset.name)

  const assetRes = await fetch(asset.url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/octet-stream',
    },
    redirect: 'follow',
  })

  if (!assetRes.ok || !assetRes.body) {
    if (assetRes.body) await assetRes.text()
    throw new UserError(`Failed to download firmware: ${assetRes.status} ${assetRes.statusText}`)
  }

  await fs.mkdir(CACHE_DIR, {recursive: true})
  await pipeline(assetRes.body, createWriteStream(archivePath))

  await fs.mkdir(extractedDir, {recursive: true})
  await execFileAsync('tar', ['xzf', archivePath, '-C', extractedDir])
  await fs.rm(archivePath)
}

async function downloadAndExtractWorkflowArtifact(
  token: string,
  repo: string,
  artifact: WorkflowArtifact,
  extractedDir: string,
): Promise<void> {
  const zipPath = path.join(CACHE_DIR, `${artifact.name}-${Date.now()}.zip`)

  const artifactUrl = `https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`
  const downloadRes = await fetch(artifactUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
    redirect: 'follow',
  })

  if (!downloadRes.ok || !downloadRes.body) {
    if (downloadRes.body) await downloadRes.text()
    throw new UserError(
      `Failed to download artifact: ${downloadRes.status} ${downloadRes.statusText}`,
    )
  }

  await fs.mkdir(path.dirname(zipPath), {recursive: true})
  await pipeline(downloadRes.body, createWriteStream(zipPath))

  // Unzip the outer GitHub artifact zip into a temp dir, then handle two
  // possible layouts: tarball pack (zip contains a single .tar.gz to extract)
  // or unpacked pack (zip contains firmware files directly — flasher_args.json
  // alongside bootloader/, partition_table/, mikrojs.bin).
  // Wipe extractedDir first so a partial previous attempt can't trip up
  // fs.rename below (ENOTEMPTY on existing subdirectories).
  await fs.rm(extractedDir, {recursive: true, force: true})
  await fs.mkdir(extractedDir, {recursive: true})
  const tmpDir = `${extractedDir}-tmp`
  await fs.mkdir(tmpDir, {recursive: true})
  await execFileAsync('unzip', ['-o', zipPath, '-d', tmpDir])

  const files = await fs.readdir(tmpDir)
  const tarball = files.find((f) => f.endsWith('.tar.gz'))
  if (tarball) {
    await execFileAsync('tar', ['xzf', path.join(tmpDir, tarball), '-C', extractedDir])
  } else if (files.includes('flasher_args.json')) {
    for (const file of files) {
      await fs.rename(path.join(tmpDir, file), path.join(extractedDir, file))
    }
  } else {
    await fs.rm(tmpDir, {recursive: true})
    await fs.rm(zipPath)
    throw new UserError(
      `Artifact '${artifact.name}' has no recognized firmware layout ` +
        `(expected a .tar.gz or flasher_args.json at the top level).`,
    )
  }

  await fs.rm(zipPath)
  await fs.rm(tmpDir, {recursive: true})
}

// ── Resolution strategies ────────────────────────────────────────────────────

async function resolveFromUrl(url: string): Promise<string> {
  const cacheKey = url.replace(/[^a-zA-Z0-9_.-]/g, '_')
  const extractedDir = path.join(CACHE_DIR, `ext-${cacheKey}`)
  const flasherArgsPath = path.join(extractedDir, 'flasher_args.json')

  try {
    await fs.access(flasherArgsPath)
    return extractedDir
  } catch {
    // Not cached
  }

  const archivePath = path.join(CACHE_DIR, `ext-${cacheKey}.tar.gz`)
  await downloadUrl(url, archivePath)

  await fs.mkdir(extractedDir, {recursive: true})
  await execFileAsync('tar', ['xzf', archivePath, '-C', extractedDir])
  await fs.rm(archivePath)

  return extractedDir
}

async function resolveViaRelease(
  token: string,
  repo: string,
  tag: string | undefined,
  chip: Chip | undefined,
  board: string | undefined,
  report: (msg: string) => void,
): Promise<string> {
  const cacheId = board === undefined ? (chip ?? 'firmware') : boardFileName(board)
  const cacheTag = tag ?? 'latest'
  const extractedDir = path.join(CACHE_DIR, `${cacheId}-${cacheTag}`)
  const flasherArgsPath = path.join(extractedDir, 'flasher_args.json')

  try {
    await fs.access(flasherArgsPath)
    return extractedDir
  } catch {
    // Not cached
  }

  const release = await fetchRelease(token, repo, tag)
  const asset = selectReleaseAsset(release.assets, chip, board, repo)
  report(`Downloading ${asset.name}…`)
  await downloadAndExtractReleaseAsset(token, asset, extractedDir)
  return extractedDir
}

async function resolveViaActions(
  token: string,
  repo: string,
  sha: string,
  chip: Chip | undefined,
  board: string | undefined,
  report: (msg: string) => void,
): Promise<string> {
  const cacheId = board === undefined ? (chip ?? 'firmware') : boardFileName(board)
  const extractedDir = path.join(CACHE_DIR, `${cacheId}-${sha}`)
  const flasherArgsPath = path.join(extractedDir, 'flasher_args.json')

  try {
    await fs.access(flasherArgsPath)
    return extractedDir
  } catch {
    // Not cached
  }

  report(`Looking for firmware build in ${repo}…`)
  const artifacts = await fetchWorkflowArtifacts(token, repo, sha)
  const artifact = selectWorkflowArtifact(artifacts, chip, board, repo)

  if (artifact.expired) {
    throw new UserError(
      `Firmware artifact '${artifact.name}' at ${sha.slice(0, 8)} has expired.\n` +
        `GitHub Actions artifacts are retained for a limited time.`,
    )
  }

  report(`Downloading ${artifact.name}…`)
  await downloadAndExtractWorkflowArtifact(token, repo, artifact, extractedDir)
  return extractedDir
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve firmware from a `--from` reference.
 *
 * Resolution order:
 * 1. URL (http/https) → download directly
 * 2. Contains `/` → external repo (user/repo or user/repo@ref)
 * 3. Starts with `v` + digit → release tag on mikrojs/mikro (fallback to Actions)
 * 4. Everything else → resolve as ref (branch/tag/SHA) on mikrojs/mikro via Actions
 *
 * Note: for mikrojs/mikro, versioned firmware (vX.Y.Z) is bundled in the
 * @mikrojs/firmware npm package and used by the default flash path. The
 * release-asset code path here is exercised by external repos that ship
 * firmware tarballs as GitHub Release assets.
 */
export async function resolveFrom(options: ResolveFromOptions): Promise<string> {
  const {from, chip, board, onProgress} = options
  const trail: string[] = []
  const step = (msg: string) => {
    trail.push(msg)
    onProgress?.(msg)
  }

  try {
    // 1. URL
    if (from.startsWith('http://') || from.startsWith('https://')) {
      step(`Downloading firmware from ${from}…`)
      return await resolveFromUrl(from)
    }

    // Parse repo and ref
    let repo: string
    let ref: string | undefined

    if (from.includes('/')) {
      // External repo: user/repo or user/repo@ref
      const atIndex = from.lastIndexOf('@')
      if (atIndex > from.indexOf('/')) {
        repo = from.slice(0, atIndex)
        ref = from.slice(atIndex + 1)
      } else {
        repo = from
        ref = undefined
      }
    } else {
      // Ref on the main repo
      repo = GITHUB_REPO
      ref = from
    }

    const token = requireGitHubToken(await getGitHubToken())

    // No ref → latest release
    if (!ref) {
      step(`Fetching latest release from ${repo}…`)
      return await resolveViaRelease(token, repo, undefined, chip, board, step)
    }

    // Release tag (v-prefix) → try Releases first, fall back to Actions
    if (isReleaseTag(ref)) {
      step(`Resolving release ${ref} from ${repo}…`)
      try {
        return await resolveViaRelease(token, repo, ref, chip, board, step)
      } catch {
        step(`No release found for ${ref}, trying CI artifacts…`)
      }
    }

    // Resolve ref (branch/tag/SHA) to commit SHA
    step(`Resolving ${ref}…`)
    const fullSha = await resolveRefToSha(token, repo, ref)
    step(`Resolved ${ref} → ${fullSha.slice(0, 8)}`)

    // Try Actions artifacts
    try {
      return await resolveViaActions(token, repo, fullSha, chip, board, step)
    } catch (actionsError) {
      // Last resort: try as release tag (handles non-v-prefix tags and expired artifacts)
      try {
        step(`CI artifact not available, trying as release tag…`)
        return await resolveViaRelease(token, repo, ref, chip, board, step)
      } catch {
        throw actionsError
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const trailStr = trail.map((s) => `  ${s}`).join('\n')
    throw new UserError(`${msg}\n\nResolution trail:\n${trailStr}`, {cause: error})
  }
}
