import {mkdir, readFile, writeFile} from 'node:fs/promises'
import * as pathlib from 'node:path'

import {compileBytecodeToHeader} from '@mikrojs/native'
import {command, constant, type InferValue, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import * as esbuild from 'esbuild'
import figures from 'figures'

import {getBuildOptions} from '../lib/esbuild.js'
import {minifyJs} from '../lib/minify.js'
import {parseMinifier, parseMinifyLevel} from '../lib/parseMinifier.js'

export const args = command(
  'build-runtime',
  object({
    action: constant('build-runtime' as const),
    outDir: argument(path({metavar: 'OUTDIR', allowCreate: true, type: 'directory'})),
    minifier: optional(
      option('--minifier', string({metavar: 'NAME'}), {
        description: message`Minifier: esbuild, terser, or swc (default: esbuild)`,
      }),
    ),
    minifyLevel: optional(
      option('--minify-level', string({metavar: 'LEVEL'}), {
        description: message`Minify level: default or max`,
      }),
    ),
  }),
  {hidden: true},
)

type RuntimeModule = {
  name: string
  entry: string
  target: string
  esbuildOptions?: {
    minify?: boolean
    bundle?: boolean
  }
}

// Resolve relative to package root (works from both src/ and dist/)
const PKG_ROOT = pathlib.join(import.meta.dirname, '../../..')
const RUNTIME_MODULES_DIR = pathlib.join(PKG_ROOT, 'src/runtime')

const MODULE_NAMES = [
  'fetch',
  'i2c',
  'neopixel',
  'pin',
  'pwm',
  'rtc',
  'sleep',
  'spi',
  'sntp',
  'stdio',
  'sys',
  'wifi',
]

function getRuntimeModules(outDir: string): RuntimeModule[] {
  const genTargetPath = pathlib.resolve(outDir)
  return MODULE_NAMES.map(
    (name): RuntimeModule => ({
      name,
      entry: pathlib.join(RUNTIME_MODULES_DIR, `${name}.ts`),
      target: pathlib.join(genTargetPath, `mikrojs_${name}.h`),
      esbuildOptions: {
        minify: true,
        bundle: true,
      },
    }),
  )
}

/**
 * Extract external import specifiers (mikrojs/*) from bundled JS source so
 * they can be declared as external modules to the bytecode compiler.
 */
function extractExternalImports(source: string): string[] {
  const imports = new Set<string>()
  for (const match of source.matchAll(/from\s*["'](mikrojs\/[^"']+)["']/g)) {
    imports.add(match[1]!)
  }
  return [...imports]
}

async function buildModule(
  module: RuntimeModule,
  options: {minifier: string; minifyLevel: string},
): Promise<{bundleBytes: number; bytecodeBytes: number}> {
  await mkdir(pathlib.dirname(module.target), {recursive: true})

  const minifier = parseMinifier(options.minifier) ?? 'esbuild'
  const minifyLevel = parseMinifyLevel(options.minifyLevel) ?? 'default'
  const useEsbuildMinify = minifier === 'esbuild'

  const buildOpts = getBuildOptions(module.entry.replace('file://', ''), {
    ...module.esbuildOptions,
    minify: useEsbuildMinify && (module.esbuildOptions?.minify ?? true),
  })
  const bundle = await esbuild.build(buildOpts)

  const output = bundle.outputFiles?.[0]
  if (!output) {
    throw new Error(`Bundling ${module.name} did not produce a file`)
  }

  let bundleSource = new TextDecoder().decode(output.contents)
  if (!useEsbuildMinify) {
    bundleSource = await minifyJs(bundleSource, minifier, minifyLevel)
  }
  const bundleBytes = Buffer.byteLength(bundleSource)
  const externals = extractExternalImports(bundleSource)
  const moduleName = `mikrojs/${module.name}`
  const symbolName = `mikrojs_${module.name}_bytecode`

  const header = compileBytecodeToHeader(bundleSource, moduleName, symbolName, externals)

  // Only write if content changed to avoid unnecessary recompilation
  const existing = await readFile(module.target, 'utf-8').catch(() => null)
  if (existing !== header) {
    await writeFile(module.target, header)
  }

  // Extract bytecode size from the generated header's array length comment
  const sizeMatch = header.match(/\[(\d+)\]/)
  const bytecodeBytes = sizeMatch ? Number(sizeMatch[1]) : 0

  return {bundleBytes, bytecodeBytes}
}

export default async function buildRuntime(props: InferValue<typeof args>) {
  const modules = getRuntimeModules(props.outDir)
  const minifierOptions = {
    minifier: props.minifier ?? 'esbuild',
    minifyLevel: props.minifyLevel ?? 'default',
  }

  const results = await Promise.allSettled(modules.map((mod) => buildModule(mod, minifierOptions)))

  for (const [i, result] of results.entries()) {
    const mod = modules[i]!

    const target = pathlib.relative(process.cwd(), mod.target)

    if (result.status === 'fulfilled') {
      const {bundleBytes, bytecodeBytes} = result.value
      // eslint-disable-next-line no-console
      console.log(
        `\t${figures.tick} Compiled runtime module: ${mod.name} (bundle: ${bundleBytes} B, bytecode: ${bytecodeBytes} B)`,
      )
    } else {
      // eslint-disable-next-line no-console
      console.error(
        `\t${figures.cross} Error compiling runtime module "${mod.name}" to ${target}: ${result.reason}`,
      )
    }
  }

  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length > 0) {
    process.exit(1)
  }
}
