import * as pathlib from 'node:path'

import type {MikroEnv, MikroJSConfig} from '../../_exports/index.js'
import {loadMikroConfig} from './loadMikroConfig.js'
import {parseSize} from './parseSize.js'
import {getMikroDir} from './projectRoot.js'

export interface ResolvedSimConfig {
  memLimit: number
  fsLimit: number
  fsRoot: string
  /** Resolved fs_read_max in bytes. Undefined means "use runtime default". */
  fsReadMax: number | undefined
}

const DEFAULT_MEM_LIMIT = 300 * 1024
const DEFAULT_FS_LIMIT = 1024 * 1024

export function resolveSimConfig(config: MikroJSConfig | null): ResolvedSimConfig {
  const sim = config?.sim ?? {}
  return {
    memLimit: sim.memLimit !== undefined ? parseSize(sim.memLimit) : DEFAULT_MEM_LIMIT,
    fsLimit: sim.fsLimit !== undefined ? parseSize(sim.fsLimit) : DEFAULT_FS_LIMIT,
    fsRoot: sim.fsRoot ?? pathlib.join(getMikroDir(), 'sim-fs'),
    // fsReadMax is a top-level option (applies on device and sim alike).
    fsReadMax: config?.fsReadMax !== undefined ? parseSize(config.fsReadMax) : undefined,
  }
}

/**
 * Convenience: walk up from `startDir` (or cwd) looking for `mikro.config.ts`,
 * then resolve the sim section with defaults filled in. The simulator is a
 * local flow, so it always resolves the `development` config environment.
 */
export async function loadSimConfig(
  startDir?: string,
  env: MikroEnv = 'development',
): Promise<ResolvedSimConfig> {
  const config = await loadMikroConfig(startDir ?? process.cwd(), env)
  return resolveSimConfig(config)
}
