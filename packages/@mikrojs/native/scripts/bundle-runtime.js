import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'

/**
 * Bundle runtime TypeScript modules to JavaScript using esbuild.
 * Output goes to a directory where qjsc can compile them to bytecode.
 *
 * Usage: node bundle-runtime.js <outdir> <runtime_dir> <mod1> <mod2> ... [--minifier=NAME] [--minify-level=LEVEL]
 */
import {build} from 'esbuild'

// Parse positional args and optional flags
const positionalArgs = []
let minifier = 'esbuild'
let minifyLevel = 'default'
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--minifier=')) {
    minifier = arg.slice('--minifier='.length)
  } else if (arg.startsWith('--minify-level=')) {
    minifyLevel = arg.slice('--minify-level='.length)
  } else {
    positionalArgs.push(arg)
  }
}

const outDir = positionalArgs[0]
const runtimeDir = positionalArgs[1]
const moduleNames = positionalArgs.slice(2)

if (!outDir || !runtimeDir || moduleNames.length === 0) {
  // eslint-disable-next-line no-console
  console.error(
    'Usage: node bundle-runtime.js <outdir> <runtime_dir> <mod1> <mod2> ... [--minifier=NAME] [--minify-level=LEVEL]',
  )
  process.exit(1)
}

// Dynamic import helper to avoid TypeScript module resolution at parse time
function importOptional(name) {
  return import(name)
}

async function minifyWithTerser(code) {
  const terser = await importOptional('terser')
  const options =
    minifyLevel === 'max'
      ? {
          module: true,
          ecma: 2020,
          compress: {
            ecma: 2020,
            module: true,
            passes: 3,
            toplevel: true,
            pure_getters: true,
            unsafe_arrows: true,
            unsafe_math: true,
            unsafe_methods: true,
          },
          mangle: {module: true, toplevel: true},
        }
      : {module: true}
  const result = await terser.minify(code, options)
  if (result.code === undefined) throw new Error('terser produced no output')
  return result.code
}

async function minifyWithSwc(code) {
  const swc = await importOptional('@swc/core')
  const options =
    minifyLevel === 'max'
      ? {
          module: true,
          compress: {
            module: true,
            passes: 3,
            toplevel: true,
            pure_getters: true,
            unsafe_arrows: true,
            unsafe_math: true,
            unsafe_methods: true,
          },
          mangle: {toplevel: true},
        }
      : {module: true}
  const result = await swc.minify(code, options)
  return result.code
}

mkdirSync(outDir, {recursive: true})

// Every source file each bundle inlined, for the duplication check below.
// name -> [{module, bytes}]
const inlinedBy = new Map()

for (const name of moduleNames) {
  // Resolve entry point: {name}/{name}.ts (core modules) or {name}.ts (board/driver)
  const nested = join(runtimeDir, name, `${name}.ts`)
  const flat = join(runtimeDir, `${name}.ts`)
  const entry = existsSync(nested) ? nested : flat
  const useEsbuildMinify = minifier === 'esbuild'
  const result = await build({
    bundle: true,
    entryPoints: [entry],
    write: false,
    minify: useEsbuildMinify,
    treeShaking: true,
    target: 'es2024',
    platform: 'neutral',
    format: 'esm',
    external: ['mikro', 'mikro/*', '@mikrojs/*', 'native:*'],
    metafile: true,
  })

  for (const output of Object.values(result.metafile.outputs)) {
    for (const [input, {bytesInOutput}] of Object.entries(output.inputs)) {
      // Zero bytes = type-only import, erased from the output.
      if (bytesInOutput === 0) continue
      if (!inlinedBy.has(input)) inlinedBy.set(input, [])
      inlinedBy.get(input).push({module: name, bytes: bytesInOutput})
    }
  }

  const output = result.outputFiles?.[0]
  if (!output) {
    // eslint-disable-next-line no-console
    console.error(`Bundling ${name} did not produce a file`)
    process.exit(1)
  }

  let source = new TextDecoder().decode(output.contents)

  // Post-process with selected minifier if not esbuild
  if (!useEsbuildMinify) {
    if (minifier === 'terser') {
      source = await minifyWithTerser(source)
    } else if (minifier === 'swc') {
      source = await minifyWithSwc(source)
    }
  }

  // Extract external imports so CMake can pass them as -M flags to qjsc
  const externals = []
  for (const match of source.matchAll(
    /(?:from|import)\s*["']((?:native:|mikro\/|@mikrojs\/)[^"']+)["']/g,
  )) {
    externals.push(match[1])
  }

  const outFile = join(outDir, `${name}.js`)
  // Module names may contain slashes (e.g. 'kv/nvs') for nested subpath
  // builtins like `mikrojs/kv/nvs`. Ensure the parent directory exists
  // before writing — writeFileSync won't create it on its own.
  mkdirSync(dirname(outFile), {recursive: true})
  writeFileSync(outFile, source)

  // Write externals list for CMake to read
  const extFile = join(outDir, `${name}.externals`)
  writeFileSync(extFile, externals.join('\n'))

  // eslint-disable-next-line no-console
  console.log(`Bundled ${name} (${Buffer.byteLength(source)} bytes, ${externals.length} externals)`)
}

// A source file inlined into more than one bundle ships (and loads) twice:
// duplicate flash bytes and a second live module instance in RAM. It happens
// when sibling builtins share a file via a RELATIVE import — cross-builtin
// `mikro/*` imports stay external and link at runtime, so the fix is to give
// the shared file its own builtin and import it as `mikro/<mod>/shared`
// (see kv/shared and ota/shared for the pattern).
const duplicated = [...inlinedBy.entries()].filter(([, users]) => users.length > 1)
if (duplicated.length > 0) {
  for (const [input, users] of duplicated) {
    // eslint-disable-next-line no-console
    console.error(
      `Duplicated across bundles: ${input} — ${users
        .map((u) => `${u.module} (${u.bytes}B)`)
        .join(', ')}`,
    )
  }
  process.exit(1)
}
