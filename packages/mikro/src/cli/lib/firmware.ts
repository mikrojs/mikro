import {execFile} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {pipeline} from 'node:stream/promises'
import {promisify} from 'node:util'

import {paths} from './envPaths.js'
import {UserError} from './errorMessage.js'

const execFileAsync = promisify(execFile)

const CACHE_DIR = path.join(paths.cache, 'firmware')

/** Chip identifier (e.g. "esp32c3", "esp32c6"). */
export type Chip = string

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

/**
 * The folder of the firmware archive at `url` (a .tar.gz as `mikro fw pack`
 * writes it), downloaded and extracted into the cache on every flash, since the
 * file at a URL like `.../releases/latest/download/...` can change.
 */
export async function resolveFrom(
  url: string,
  onProgress?: (message: string) => void,
): Promise<string> {
  const cacheKey = url.replace(/[^a-zA-Z0-9_.-]/g, '_')
  const extractedDir = path.join(CACHE_DIR, `ext-${cacheKey}`)
  onProgress?.(`Downloading firmware from ${url}…`)
  const archivePath = path.join(CACHE_DIR, `ext-${cacheKey}.tar.gz`)
  await downloadUrl(url, archivePath)

  await fs.rm(extractedDir, {recursive: true, force: true})
  await fs.mkdir(extractedDir, {recursive: true})
  await execFileAsync('tar', ['xzf', archivePath, '-C', extractedDir])
  await fs.rm(archivePath)

  return extractedDir
}
