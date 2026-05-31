import {execFile} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {pipeline} from 'node:stream/promises'
import {promisify} from 'node:util'

import envPaths from 'env-paths'

const execFileAsync = promisify(execFile)

const ESPTOOL_VERSION = 'v5.2.0'
const GITHUB_REPO = 'espressif/esptool'

const CACHE_DIR = path.join(envPaths('mikro', {suffix: ''}).cache, 'esptool')

type Platform = 'linux' | 'macos' | 'windows'
type Arch = 'amd64' | 'aarch64' | 'arm64'

function getPlatform(): Platform {
  switch (os.platform()) {
    case 'linux':
      return 'linux'
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`)
  }
}

function getArch(): Arch {
  switch (os.arch()) {
    case 'x64':
      return 'amd64'
    case 'arm64':
      return getPlatform() === 'linux' ? 'aarch64' : 'arm64'
    default:
      throw new Error(`Unsupported architecture: ${os.arch()}`)
  }
}

function getAssetName(platform: Platform, arch: Arch): string {
  const ext = platform === 'windows' ? 'zip' : 'tar.gz'
  return `esptool-${ESPTOOL_VERSION}-${platform}-${arch}.${ext}`
}

function getExtractedDirName(platform: Platform, arch: Arch): string {
  return `esptool-${platform}-${arch}`
}

function getBinaryName(platform: Platform): string {
  return platform === 'windows' ? 'esptool.exe' : 'esptool'
}

function getDownloadUrl(assetName: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/${ESPTOOL_VERSION}/${assetName}`
}

async function download(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, {redirect: 'follow'})
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error(`No response body from ${url}`)
  }
  await fs.mkdir(path.dirname(destPath), {recursive: true})
  const fileStream = createWriteStream(destPath)
  await pipeline(response.body, fileStream)
}

/**
 * Get the path to the esptool binary, downloading it if necessary.
 */
export async function getEsptoolPath(): Promise<string> {
  const platform = getPlatform()
  const arch = getArch()
  const binaryName = getBinaryName(platform)
  const extractedDir = getExtractedDirName(platform, arch)
  const binaryPath = path.join(CACHE_DIR, ESPTOOL_VERSION, extractedDir, binaryName)

  // Check if already cached
  try {
    await fs.access(binaryPath, fs.constants.X_OK)
    return binaryPath
  } catch {
    // Not cached, proceed with download
  }

  const assetName = getAssetName(platform, arch)
  const downloadUrl = getDownloadUrl(assetName)
  const versionDir = path.join(CACHE_DIR, ESPTOOL_VERSION)
  const archivePath = path.join(versionDir, assetName)

  await fs.mkdir(versionDir, {recursive: true})
  await download(downloadUrl, archivePath)

  if (platform === 'windows') {
    await execFileAsync('unzip', ['-o', archivePath, '-d', versionDir])
  } else {
    await execFileAsync('tar', ['xzf', archivePath, '-C', versionDir])
  }

  // Clean up the archive
  await fs.rm(archivePath)

  // Ensure the binary is executable
  await fs.chmod(binaryPath, 0o755)

  return binaryPath
}

export {ESPTOOL_VERSION}
