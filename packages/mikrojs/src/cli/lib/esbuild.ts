import type {BuildOptions} from 'esbuild'

import {BUILTIN_EXTERNALS} from '../../constants.js'

export interface BuildConfig {
  minify?: boolean
  bundle?: boolean
}

export function getBuildOptions(entryFile: string, config: BuildConfig): BuildOptions {
  return {
    bundle: config.bundle,
    entryPoints: [entryFile],
    write: false,
    minify: config.minify,
    treeShaking: true,
    target: 'es2024',
    platform: 'neutral',
    format: 'esm',
    external: config.bundle ? BUILTIN_EXTERNALS : undefined,
  }
}
