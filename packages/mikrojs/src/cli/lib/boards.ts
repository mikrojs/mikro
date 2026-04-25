import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface BoardInfo {
  /** Board name (e.g. "xiao-esp32c6") */
  name: string
  /** Target chip (e.g. "esp32s3") */
  chip: string
  /** Human-readable description */
  description?: string
  /** Path to runtime TS file (absolute) */
  runtimePath?: string
  /** Path to sdkconfig defaults file (absolute) */
  sdkconfigPath?: string
  /** Package that provides this board (e.g. "@mikrojs/some-board") */
  packageName: string
  /** Import specifier (e.g. "@mikrojs/some-board/some-variant") */
  importSpecifier: string
}

interface BoardManifestEntry {
  chip: string
  runtime?: string
  sdkconfig?: string
  description?: string
}

interface PkgJson {
  name?: string
  dependencies?: Record<string, string>
  mikrojs?: {
    boards?: Record<string, BoardManifestEntry>
  }
}

/**
 * Discover boards from the current project's package.json dependencies.
 * Scans all dependencies for packages with a `mikrojs.boards` field.
 * Board keys are subpath exports (e.g. "./xiao-esp32c6").
 */
export async function discoverBoards(projectDir: string): Promise<BoardInfo[]> {
  const pkgPath = path.join(projectDir, 'package.json')
  let pkg: PkgJson
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as PkgJson
  } catch {
    return []
  }

  const deps = {...pkg.dependencies}
  const boards: BoardInfo[] = []

  for (const depName of Object.keys(deps)) {
    let depPkgPath: string
    let depPkg: PkgJson
    try {
      depPkgPath = await resolvePackageJson(depName, projectDir)
      depPkg = JSON.parse(await fs.readFile(depPkgPath, 'utf8')) as PkgJson
    } catch {
      continue
    }

    if (!depPkg.mikrojs?.boards) continue

    const depDir = path.dirname(depPkgPath)

    for (const [subpath, boardConfig] of Object.entries(depPkg.mikrojs.boards)) {
      // Strip leading "./" from subpath to get the board name
      const name = subpath.startsWith('./') ? subpath.slice(2) : subpath
      boards.push({
        name,
        chip: boardConfig.chip,
        description: boardConfig.description,
        runtimePath: boardConfig.runtime ? path.resolve(depDir, boardConfig.runtime) : undefined,
        sdkconfigPath: boardConfig.sdkconfig
          ? path.resolve(depDir, boardConfig.sdkconfig)
          : undefined,
        packageName: depName,
        importSpecifier: `${depName}/${name}`,
      })
    }
  }

  return boards
}

async function resolvePackageJson(packageName: string, fromDir: string): Promise<string> {
  let dir = fromDir
  while (true) {
    const candidate = path.join(dir, 'node_modules', packageName, 'package.json')
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw new Error(`Cannot find package ${packageName}`)
}
