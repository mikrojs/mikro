import * as path from 'node:path'

import {
  type BoardImage,
  type BoardProblem,
  firmwareExports,
  loadBoards,
} from '@mikrojs/firmware/boards'
import {findPackageDir, findPackageRoot} from '@mikrojs/firmware/manifest'

/** This CLI's package: src/cli/lib (or dist/cli/lib) is three levels down. */
const ownPackageDir = path.join(import.meta.dirname, '..', '..', '..')

/**
 * The `mikro` package whose generic images are the bundled boards: the app's
 * own, so the images match the version the app installed, whichever CLI runs.
 * Else this CLI's: outside an app, or for an app whose `mikro` has no images.
 */
export function bundledBoardsDir(projectDir: string = process.cwd()): string {
  const app = findPackageRoot(projectDir)
  const mikro = app === undefined ? undefined : findPackageDir('mikro', app)
  return mikro !== undefined && firmwareExports(mikro).entries.length > 0 ? mikro : ownPackageDir
}

/** The generic images of the bundled boards, one per chip. In the repository
 *  they are not built; the release builds them. */
export function bundledImages(projectDir?: string): {
  boards: BoardImage[]
  problems: BoardProblem[]
} {
  return loadBoards(bundledBoardsDir(projectDir))
}
