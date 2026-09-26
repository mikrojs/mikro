import {existsSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import * as pathlib from 'node:path'

import {
  applyRewrites,
  type DeployedFile,
  type DuplicatePackage,
  type Rewrite,
  traceImports,
} from '@mikrojs/analyze-imports'
import {mkdir, readdir, readFile, rm, stat, unlink, writeFile} from 'fs/promises'
import {
  concat,
  defer,
  EMPTY,
  filter,
  from,
  ignoreElements,
  mergeMap,
  type Observable,
  of,
  throwError,
} from 'rxjs'

import type {
  LogLevel,
  MikroEnv,
  MikroJSConfig,
  Minifier,
  MinifyLevel,
} from '../../_exports/index.js'
import {isBuiltinModule} from '../../constants.js'
import {
  allFeatures,
  builtinModules,
  isTableModule,
  isTypesOnlyModule,
  moduleFeature,
  requiredFeatures,
} from './capabilities.js'
import {didYouMean} from './didYouMean.js'
import {UserError} from './errorMessage.js'
import {nativeModuleLabel} from './firmwareModules.js'
import {loadMikroConfig} from './loadMikroConfig.js'
import {minifyJs} from './minify.js'
import {parseSize} from './parseSize.js'

/** Console methods to mark as pure (side-effect-free) for each log level.
 * The minifier drops pure calls whose return value is unused, eliminating
 * both the call and its argument expressions. */
const LOG_LEVEL_PURE_FUNCS: Record<LogLevel, string[]> = {
  debug: [],
  info: ['console.debug'],
  warn: ['console.debug', 'console.log', 'console.info'],
  error: ['console.debug', 'console.log', 'console.info', 'console.warn'],
  none: ['console.debug', 'console.log', 'console.info', 'console.warn', 'console.error'],
}

// Lazy-load @mikrojs/native so commands that never compile bytecode or JSON
// (clean, console, env, list, erase, etc.) don't pay the addon load cost and,
// more importantly, don't silently hang at CLI startup if the .node file is
// stale or corrupt. Cached after first successful resolve so repeated calls
// during a single build run don't re-enter the loader.
type MikrojsNative = typeof import('@mikrojs/native')
let nativePromise: Promise<MikrojsNative> | null = null
function loadNative(): Promise<MikrojsNative> {
  if (!nativePromise) {
    nativePromise = import('@mikrojs/native').catch((err: unknown) => {
      // Reset so the next call can try again (e.g. after a rebuild).
      nativePromise = null
      const detail = err instanceof Error ? err.message : String(err)
      throw new UserError(
        `Failed to load @mikrojs/native (required for bytecode / JSON compilation). ` +
          `Try rebuilding the native addon: pnpm -F @mikrojs/native build:native\n\n` +
          `Underlying error: ${detail}`,
      )
    })
  }
  return nativePromise
}

/** How a builtin was imported. Dynamic-only imports never gate a deploy. */
type BuiltinImportKind = 'static' | 'dynamic'

/** An import of a native module (by its package specifier) and where its
 * C/C++ lives (`<package>/<dir>`), for messages. */
interface NativeImport {
  kind: BuiltinImportKind
  owner: string
}

/** Record a native module import, static winning over dynamic. */
function recordNative(
  imports: Map<string, NativeImport>,
  id: string,
  kind: BuiltinImportKind,
  owner: string,
): void {
  const seen = imports.get(id)
  if (seen === undefined || (kind === 'static' && seen.kind === 'dynamic')) {
    imports.set(id, {kind, owner})
  }
}

function unknownModuleError(name: string): string {
  if (isTypesOnlyModule(name)) {
    return `'mikro/${name}' exports types only. Import it with \`import type\`.`
  }
  const suggestion = didYouMean(name, builtinModules())
  return (
    `Unknown module 'mikro/${name}'` +
    (suggestion === undefined ? '' : `. Did you mean 'mikro/${suggestion}'?`)
  )
}

/** esbuild plugin that marks mikrojs firmware builtins as external so the
 * on-device loader resolves them against the firmware instead of esbuild
 * trying to inline their source. Board and driver packages are ordinary JS
 * and bundle; only their native modules (exports that target C/C++) stay
 * external, each reported through `onNativeImport` with its import kind and
 * importer.
 * `mikro/*` names are validated against the capability table; each resolved
 * one is reported through `onBuiltinImport` with its import kind. */
function mikrojsExternalsPlugin(
  onBuiltinImport?: (name: string, kind: BuiltinImportKind) => void,
  onNativeImport?: (id: string, kind: BuiltinImportKind, owner: string) => void,
): import('esbuild').Plugin {
  return {
    name: 'mikrojs-externals',
    setup(build) {
      build.onResolve({filter: /^(mikro$|mikro\/|native:)/}, (args) => {
        const kind = args.kind === 'dynamic-import' ? 'dynamic' : 'static'
        if (args.path.startsWith('mikro/')) {
          const name = args.path.slice('mikro/'.length)
          if (!isTableModule(name)) {
            return {errors: [{text: unknownModuleError(name)}]}
          }
          onBuiltinImport?.(name, kind)
        }
        return {path: args.path, external: true}
      })
      // A bare package specifier (scoped `@scope/...` or unscoped `name/...`)
      // that resolves to a native module is externalized: the firmware binds it.
      build.onResolve({filter: /^@?[^./]/}, (args) => {
        const fromDir = args.resolveDir || process.cwd()
        // A native module (its export targets C/C++): the firmware provides it.
        const owner = nativeModuleLabel(args.path, fromDir)
        if (owner !== undefined) {
          onNativeImport?.(args.path, args.kind === 'dynamic-import' ? 'dynamic' : 'static', owner)
          return {path: args.path, external: true}
        }
        return null
      })
    },
  }
}

/** Top-level directory of a normalized relative entry path: `app/debug/test.ts`
 * → `app`, `main.ts` → `.`. Deploy promotes only the tree's top-level app dir
 * and the firmware searches for package.json at most one directory deep, so the
 * deploy tree root must be the entry's top-level dir, not its immediate parent. */
export function entryRootDir(entry: string): string {
  const idx = entry.indexOf(pathlib.sep)
  return idx === -1 ? '.' : entry.slice(0, idx)
}

/** Firmware features the built app needs, derived from its import graph and
 *  the config's feature floor. Carried on the `features` BuildEvent and the
 *  pack artifact so deploy can gate against the device's feature set. */
export interface BuildFeatures {
  /** Features required by statically imported gated modules. */
  imported: string[]
  /** `config.features` floor entries not already covered by an import.
   *  Gate a deploy like `imported`. */
  floor: string[]
  /** Features needed only by dynamic-only import()s. Never gate a deploy
   *  unless the floor also names them. */
  optional: string[]
  /** Feature → statically imported builtin modules that require it. */
  modules: Record<string, string[]>
  /** Native modules the app imports, by package specifier
   * (`@mikrojs/drivers/sh8601`), which only firmware built with them provides. */
  natives: NativeNeeds
}

export interface NativeNeeds {
  /** Statically imported native modules; gate a deploy. */
  imported: string[]
  /** Dynamically-only imported native modules. Never gate a deploy. */
  optional: string[]
  /** Specifier → where the module's C/C++ lives (`<package>/<dir>`), for messages. */
  owners: Record<string, string>
}

export type BuildEvent =
  | {type: 'phase'; phase: string}
  | {type: 'file'; path: string; size: number}
  | {type: 'done'}
  | ({type: 'features'} & BuildFeatures)
  /** What this build actually resolved to, once mikro.config.ts has been read.
   *  Emitted before any work, so a caller can report the settings that applied
   *  rather than re-deriving them from its own flags and missing the config. */
  | {
      type: 'settings'
      minify: boolean
      minifier: Minifier
      minifyLevel: MinifyLevel
      logLevel: LogLevel
      bundle: boolean
    }
  /** Packages the deploy tree holds more than once, by deploy path. A notice,
   *  not an error: the build still succeeds. Not emitted for bundled builds. */
  | {type: 'duplicatePackages'; packages: DuplicatePackage[]}

function phase(name: string): Observable<BuildEvent> {
  return of({type: 'phase' as const, phase: name})
}

function computeFeatures(
  builtinImports: Map<string, BuiltinImportKind> | undefined,
  nativeImports: Map<string, NativeImport> | undefined,
  configFloor: readonly string[] | undefined,
): BuildFeatures {
  const entries = [...(builtinImports ?? [])]
  const staticNames = entries.filter(([, kind]) => kind === 'static').map(([name]) => name)
  const dynamicNames = entries.filter(([, kind]) => kind === 'dynamic').map(([name]) => name)
  const imported = requiredFeatures(staticNames)
  const optional = requiredFeatures(dynamicNames).filter((f) => !imported.includes(f))
  const floorSet = new Set(configFloor ?? [])
  const floor = allFeatures().filter((f) => floorSet.has(f) && !imported.includes(f))
  const modules: Record<string, string[]> = {}
  for (const name of staticNames) {
    const feature = moduleFeature(name)
    if (feature !== undefined) (modules[feature] ??= []).push(name)
  }
  const natives: NativeNeeds = {imported: [], optional: [], owners: {}}
  for (const [id, {kind, owner}] of [...(nativeImports ?? [])].sort()) {
    natives[kind === 'static' ? 'imported' : 'optional'].push(id)
    natives.owners[id] = owner
  }
  return {imported, floor, optional, modules, natives}
}

async function collectOutputFiles(buildDir: string): Promise<BuildEvent[]> {
  const entries = await readdir(buildDir, {recursive: true})
  const events: BuildEvent[] = []
  for (const entry of entries) {
    if (entry === OUT_DIR_MARKER) continue
    const full = pathlib.join(buildDir, entry)
    const s = await stat(full)
    if (s.isFile()) {
      events.push({type: 'file', path: '/' + entry, size: s.size})
    }
  }
  return events
}

/** Marks an output directory as made by the build, so a later build may delete it. */
export const OUT_DIR_MARKER = '.mikro-build'

/** Delete buildDir before a build. With `marked`, refuse a non-empty directory
 *  without the marker, since it may hold the user's own files, and mark it again. */
async function emptyBuildDir(buildDir: string, marked: boolean): Promise<void> {
  if (marked) {
    const entries: string[] = await readdir(buildDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return []
      throw err
    })
    if (entries.length > 0 && !entries.includes(OUT_DIR_MARKER)) {
      throw new UserError(
        `Refusing to delete ${buildDir}: it is not empty and has no ${OUT_DIR_MARKER} file, ` +
          'so it was not made by mikro build. Choose a new or empty output directory.',
      )
    }
  }
  await rm(buildDir, {force: true, recursive: true})
  if (marked) {
    await mkdir(buildDir, {recursive: true})
    await writeFile(
      pathlib.join(buildDir, OUT_DIR_MARKER),
      'Output of mikro build. This directory is deleted and recreated on every build.\n',
    )
  }
}

function duplicatePackagesEvent(duplicates: DuplicatePackage[]): Observable<BuildEvent> {
  if (duplicates.length === 0) return EMPTY
  return of({type: 'duplicatePackages' as const, packages: duplicates})
}

/** `rootDir` becomes the root of the deploy tree: traced files outside it (e.g.
 *  node_modules/ when rootDir is a subdirectory) are placed inside it, and the
 *  rewritten import specifiers point there. */
export async function trace(entries: string[], rootDir: string) {
  const nativeOwners = new Map<string, string>()
  const {files, problems, duplicatePackages, externals} = await traceImports(entries, {
    deployDir: rootDir,
    conditions: ['import'],
    assetExtensions: ['.txt'],
    // Every mikro/* name is the firmware's; unknown ones are rejected below.
    isExternal: (id, importer) => {
      if (id.startsWith('mikro/') || isBuiltinModule(id)) return true
      if (!/^@?[^./]/.test(id)) return false
      const fromDir = pathlib.dirname(importer)
      // A native module (its export targets C/C++): the firmware provides it,
      // so nothing of it is traced or deployed.
      const owner = nativeModuleLabel(id, fromDir)
      if (owner !== undefined) {
        nativeOwners.set(id, owner)
        return true
      }
      // Board and driver packages are traced and deployed like any JS.
      return false
    },
  })
  const names = [...externals.keys()]
    .filter((id) => id.startsWith('mikro/'))
    .map((id) => id.slice('mikro/'.length))
  const unknown = names.filter((name) => !isTableModule(name))
  if (unknown.length > 0) {
    throw new UserError(unknown.map(unknownModuleError).join('\n'))
  }
  const builtinImports = new Map<string, BuiltinImportKind>(
    names.map((name) => [name, externals.get(`mikro/${name}`)!]),
  )
  // `transform` applies rewrites to these only. Any other file would deploy with
  // its imports as written, which the device cannot load.
  for (const [path, file] of files) {
    if ('contents' in file || file.rewrites.length === 0) continue
    if (REWRITABLE.includes(pathlib.extname(file.source))) continue
    problems.push(
      `Cannot deploy "${path}": its imports have to be rewritten, and the build rewrites ` +
        `only ${REWRITABLE.join(', ')} files`,
    )
  }
  if (problems.length > 0) throw new UserError(problems.join('\n'))
  const nativeImports = new Map<string, NativeImport>()
  for (const [id, owner] of nativeOwners) {
    recordNative(nativeImports, id, externals.get(id) === 'dynamic' ? 'dynamic' : 'static', owner)
  }
  return {files, duplicatePackages, builtinImports, nativeImports}
}

const REWRITABLE = ['.ts', '.js', '.mjs']

type TransformOptions = {
  minify: boolean
  minifier: Minifier
  minifyLevel: MinifyLevel
  pureFuncs?: string[]
}

/** Traces `entries` and writes every file that deploys into `buildDir`. */
function writeTraced(
  entries: string[],
  rootDir: string,
  buildDir: string,
  options: TransformOptions,
  onImports: (builtins: Map<string, BuiltinImportKind>, natives: Map<string, NativeImport>) => void,
): Observable<BuildEvent> {
  return defer(() => trace(entries, rootDir)).pipe(
    mergeMap(({files, duplicatePackages, builtinImports, nativeImports}) => {
      onImports(builtinImports, nativeImports)
      return concat(
        duplicatePackagesEvent(duplicatePackages),
        writeTracedFiles(files, buildDir, options),
      )
    }),
  )
}

function writeTracedFiles(
  files: Map<string, DeployedFile>,
  buildDir: string,
  options: TransformOptions,
) {
  return from(files).pipe(
    mergeMap(async ([path, file]) => {
      // A package.json the trace wrote, so the package is importable by name.
      if ('contents' in file) return output(buildDir, path, file.contents)
      const {source, rewrites} = file
      const contents = await transform(source, await readFile(source), rewrites, options)
      return output(buildDir, path, contents)
    }),
    ignoreElements(),
  )
}

export function loadConfig(entry: string, env?: MikroEnv): Promise<MikroJSConfig | null> {
  return loadMikroConfig(pathlib.dirname(pathlib.resolve(entry)), env)
}

/** Default directory for file logging when the user opts in via
 * `logFile: true` or omits `logFile.dir`. Mirrored in the CLI's
 * `logs pull` command so it can locate the same file the firmware
 * writes to. */
const DEFAULT_LOG_DIR = '/appfs/logs'

// Strip host-only sections, normalize K/M-suffixed sizes, and flatten the
// `wifi: {country, hostname}`, `logFile: {...}` and `watchdog: {...}` groups
// into dotted-key form so the device-side JSON parser (mik_app_config.cpp)
// can read them without a nested-object pass.
function serializeRuntimeConfig(config: MikroJSConfig): Record<string, unknown> {
  // `env` is resolved away at load time; drop it defensively so the override
  // map can never leak into the device JSON. `otaConfigSchema` is host-only
  // (the config schema ships in the manifest, not here). `board` and
  // `features` steer flash/build on the host and must not reach the device.
  const {
    sim: _sim,
    build: _build,
    env: _env,
    otaConfigSchema: _otaConfigSchema,
    board: _board,
    features: _features,
    wifi,
    logFile,
    fsReadMax,
    onPanic,
    watchdog,
    ...rest
  } = config
  const out: Record<string, unknown> = {...rest}
  if (fsReadMax !== undefined) out.fsReadMax = parseSize(fsReadMax)
  if (wifi?.country) out['wifi.country'] = wifi.country
  if (wifi?.hostname) out['wifi.hostname'] = wifi.hostname
  if (onPanic !== undefined) {
    out['onPanic.mode'] = onPanic.mode
    if (onPanic.delay !== undefined) out['onPanic.delay'] = onPanic.delay
    if (onPanic.mode === 'deepSleep') out['onPanic.duration'] = onPanic.duration
  }
  if (watchdog !== undefined) {
    // The device reads numbers only; `false` becomes the 0 it treats as disabled.
    if (watchdog.blocking !== undefined) {
      out['watchdog.blocking'] = watchdog.blocking === false ? 0 : watchdog.blocking
    }
    if (watchdog.feed !== undefined) out['watchdog.feed'] = watchdog.feed
    if (watchdog.awake !== undefined) out['watchdog.awake'] = watchdog.awake
  }
  if (logFile !== undefined) {
    const opts = logFile === true ? {} : logFile
    out['logFile.dir'] = opts.dir ?? DEFAULT_LOG_DIR
    if (opts.maxSize !== undefined) out['logFile.maxSize'] = parseSize(opts.maxSize)
    if (opts.flush !== undefined) out['logFile.flush'] = opts.flush
  }
  return out
}

export function build(
  entry: string,
  buildDir: string,
  options: {
    minify: boolean
    bytecode: boolean
    minifier?: Minifier
    minifyLevel?: MinifyLevel
    logLevel?: LogLevel
    rootDir?: string
    bundle?: boolean
    /** Config environment to resolve from mikro.config.ts ('development' or
     * 'production'). Defaults to 'production'. */
    env?: MikroEnv
    /** buildDir was chosen by the user: only delete it if a previous build
     *  marked it (or it is empty), and mark it for the next one. */
    markOutDir?: boolean
    /** Version for the deployed package.json, over the project's. The device
     *  reports that version, so `ota pack --snapshot` passes its derived one. */
    version?: string
  },
): Observable<BuildEvent> {
  // Resolve the entry to a cwd-relative path so absolute paths (drag-and-drop,
  // tab completion) and `./`-prefixed paths build the same tree: the rootDir
  // prefix checks below compare against traced file paths, which are
  // cwd-relative with no `./` prefix.
  entry = pathlib.relative(process.cwd(), pathlib.resolve(entry))
  // rootDir is the directory that becomes the root of the deploy tree.
  // Files outside it are co-located into it (so node_modules/ is findable by
  // the on-device module resolver). Files inside it keep their relative
  // position, which matters for bytecode: the baked-in module name is the
  // file's buildDir-relative path, and must match the on-device deploy path.
  // Defaults to the entry's top-level dir. Test runner overrides with the
  // user's app dir so that tests deeper than entry's parent still co-locate
  // correctly.
  const rootDir = options.rootDir ?? entryRootDir(entry)
  const env = options.env ?? 'production'
  return defer(() => loadConfig(entry, env)).pipe(
    mergeMap((config) => {
      const shouldBundle = options.bundle ?? config?.build?.bundle ?? false
      const minifier = options.minifier ?? config?.build?.minifier ?? 'esbuild'
      const minifyLevel = options.minifyLevel ?? config?.build?.minifyLevel ?? 'default'
      // --loglevel, then mikro.config.ts, then per environment: production
      // drops console.debug/log/info, development and test keep every call.
      const logLevel =
        options.logLevel ?? config?.build?.logLevel ?? (env === 'production' ? 'warn' : 'debug')
      const pureFuncs = LOG_LEVEL_PURE_FUNCS[logLevel]
      const entryJs = entry.replace(/\.ts$/, '.js')
      const entryOutputPath =
        rootDir === '.' || entryJs.startsWith(rootDir + '/')
          ? entryJs
          : pathlib.join(rootDir, entryJs)

      // Populated by whichever write path runs; read by the features event
      // emitted after it.
      let builtinImports: Map<string, BuiltinImportKind> | undefined
      let nativeImports: Map<string, NativeImport> | undefined

      const writeFilesUnbundled = writeTraced(
        [entry],
        rootDir,
        buildDir,
        {minify: options.minify, minifier, minifyLevel, pureFuncs},
        (traced, natives) => {
          builtinImports = traced
          nativeImports = natives
        },
      )

      const writeFilesBundled = defer(async () => {
        const esbuild = await import('esbuild')
        const useEsbuildMinify = options.minify && minifier === 'esbuild'
        // Virtual outdir: write: false means esbuild never touches disk, but
        // splitting: true still needs an outdir to compute chunk paths.
        // Pairing it with outbase = dirname(entry) makes the entry chunk
        // land at `<outdir>/<entry-basename>.js` with shared chunks as
        // siblings, so relative() gives us clean, prefix-free paths.
        const virtualOutdir = pathlib.resolve(process.cwd(), '__mikro_bundle_out__')
        const entryDir = pathlib.dirname(entry)
        const bundleImports = new Map<string, BuiltinImportKind>()
        const bundleNatives = new Map<string, NativeImport>()
        builtinImports = bundleImports
        nativeImports = bundleNatives
        const result = await esbuild
          .build({
            entryPoints: [entry],
            // esbuild's service keeps the cwd it was started with; a later
            // build from another directory (tests, a multi-project session)
            // would resolve the entry against the stale one.
            absWorkingDir: process.cwd(),
            bundle: true,
            splitting: true,
            outdir: virtualOutdir,
            outbase: entryDir,
            write: false,
            minify: useEsbuildMinify,
            treeShaking: true,
            target: 'es2024',
            platform: 'neutral',
            format: 'esm',
            legalComments: 'none',
            logLevel: 'silent',
            plugins: [
              mikrojsExternalsPlugin(
                (name, kind) => {
                  // Static wins: a module imported both ways gates like a static one.
                  if (kind === 'static' || !bundleImports.has(name)) bundleImports.set(name, kind)
                },
                (id, kind, owner) => recordNative(bundleNatives, id, kind, owner),
              ),
            ],
            ...(pureFuncs.length > 0 ? {pure: pureFuncs} : undefined),
          })
          .catch((err: unknown) => {
            // esbuild rejects with its own error carrying the message array;
            // rethrow just the texts so plugin errors surface cleanly.
            const errors = (err as {errors?: {text: string}[]} | null)?.errors
            if (errors && errors.length > 0) {
              throw new UserError(errors.map((e) => e.text).join('\n'))
            }
            throw err
          })
        if (result.errors.length > 0) {
          throw new UserError(result.errors.map((e) => e.text).join('\n'))
        }
        if (!result.outputFiles || result.outputFiles.length === 0) {
          throw new Error('esbuild produced no output')
        }
        const outputPrefix = pathlib.dirname(entryOutputPath)
        for (const outFile of result.outputFiles) {
          let code = outFile.text
          if (options.minify && minifier !== 'esbuild') {
            code = await minifyJs(code, minifier, minifyLevel, pureFuncs)
          }
          const rel = pathlib.relative(virtualOutdir, outFile.path)
          const outputPath =
            outputPrefix === '.' || outputPrefix === '' ? rel : pathlib.join(outputPrefix, rel)
          await output(buildDir, outputPath, code)
        }
      }).pipe(ignoreElements())

      const writeFiles = shouldBundle ? writeFilesBundled : writeFilesUnbundled

      const writeConfig = defer(() => {
        if (config === null) return EMPTY
        return output(
          buildDir,
          pathlib.join(rootDir, 'mikro.config.json'),
          JSON.stringify(serializeRuntimeConfig(config)),
        )
      })

      // Write package.json into the app directory with name, version, type, and main
      const writePackageJson = defer(async () => {
        const pkgPath = pathlib.join(process.cwd(), 'package.json')
        const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
        // Mirror writeFiles' co-locate logic: files outside rootDir are
        // placed under it (e.g. `test/x.test.ts` with rootDir=`app` lands at
        // `app/test/x.test.js`). The package.json main must therefore be the
        // file's path relative to rootDir *after* that placement, not a
        // naive pathlib.relative which would produce "../test/..." for
        // cross-parent entries and point outside /app on device.
        const mainPath =
          rootDir === '.' || entryJs.startsWith(rootDir + '/')
            ? pathlib.relative(rootDir, entryJs)
            : entryJs
        return output(
          buildDir,
          pathlib.join(rootDir, 'package.json'),
          JSON.stringify({
            name: pkg.name,
            version: options.version ?? pkg.version,
            type: pkg.type,
            main: `./${mainPath}`,
          }),
        )
      })

      // Locate the project's static/ directory by walking up from the
      // entry's parent until we find one. This handles both the
      // `mikro deploy` case (entry = app/main.ts → static at app/static/)
      // and the `mikro test` case (entry = app/**/x.test.ts → still
      // resolves the same app/static/ by walking up). The search stops
      // at the cwd so a user running from the wrong directory doesn't
      // accidentally pick up an unrelated static dir.
      const staticDir = (() => {
        let dir = pathlib.dirname(entry)
        while (dir !== '.' && dir !== '' && dir !== '/') {
          const candidate = pathlib.join(dir, 'static')
          if (existsSync(candidate)) return candidate
          const parent = pathlib.dirname(dir)
          if (parent === dir) break
          dir = parent
        }
        const rootCandidate = 'static'
        if (existsSync(rootCandidate)) return rootCandidate
        return null
      })()
      // On-device output path mirrors the source layout so read sites
      // like `readFile('/app/static/…')` resolve the same deployed path
      // regardless of which entry the build was run with.
      const staticOutputDir = staticDir ?? pathlib.join(rootDir, 'static')
      let staticFiles: string[] = []
      const writeStatic = defer(async () => {
        if (!staticDir) return
        try {
          const s = await stat(staticDir)
          if (s.isDirectory()) {
            staticFiles = await copyStaticDir(staticDir, buildDir, staticOutputDir)
          }
        } catch {
          // No static directory — nothing to copy
        }
      })

      return concat(
        of<BuildEvent>({
          type: 'settings',
          minify: options.minify,
          minifier,
          minifyLevel,
          logLevel,
          bundle: shouldBundle,
        }),
        phase(shouldBundle ? 'Bundling' : 'Tracing imports'),
        defer(() => emptyBuildDir(buildDir, options.markOutDir === true)).pipe(ignoreElements()),
        writeFiles,
        // After writeFiles: both write paths populate builtinImports as they run.
        defer(() =>
          of<BuildEvent>({
            type: 'features',
            ...computeFeatures(builtinImports, nativeImports, config?.features),
          }),
        ),
        writePackageJson.pipe(ignoreElements()),
        writeConfig.pipe(ignoreElements()),
        writeStatic.pipe(ignoreElements()),
        options.bytecode
          ? concat(
              phase('Compiling bytecode'),
              defer(() => {
                const keepPlain = new Set([
                  pathlib.resolve(buildDir, rootDir, 'package.json'),
                  pathlib.resolve(buildDir, rootDir, 'mikro.config.json'),
                  ...staticFiles,
                ])
                return compileJson(buildDir, keepPlain)
              }).pipe(ignoreElements()),
              defer(() => {
                const skip = new Set(staticFiles)
                return compileBytecode(buildDir, skip)
              }).pipe(ignoreElements()),
            )
          : EMPTY,
        defer(() => collectOutputFiles(buildDir)).pipe(mergeMap((events) => from(events))),
        of({type: 'done' as const}),
      )
    }),
  )
}

/**
 * Build multiple test files into one unbundled deploy tree. Writes a
 * synthesized package.json carrying a `tests` array that the firmware
 * supervisor uses as its sole "test mode" signal. Each path runs in
 * its own fresh runtime through one transport session.
 *
 * Always unbundled (bundling would defeat per-file isolation and
 * inflates deploy size via duplicated shared deps). No `main` field:
 * the supervisor drives iteration from `tests`, and leaving `main` out
 * makes the intent obvious to anyone reading the deployed bundle.
 */
export function buildTests(
  entries: string[],
  buildDir: string,
  options: {
    minify: boolean
    bytecode: boolean
    minifier?: Minifier
    minifyLevel?: MinifyLevel
    logLevel?: LogLevel
    rootDir: string
    /** Config environment to resolve from mikro.config.ts. Tests always build
     * in 'development'. */
    env?: MikroEnv
  },
): Observable<BuildEvent> {
  if (entries.length === 0) {
    return throwError(() => new Error('buildTests: no entries'))
  }
  // Same resolution as build(): prefix checks require cwd-relative paths.
  entries = entries.map((e) => pathlib.relative(process.cwd(), pathlib.resolve(e)))
  const rootDir = options.rootDir
  // Load config from the first entry's directory; assume all tests share a project.
  return defer(() => loadConfig(entries[0]!, options.env)).pipe(
    mergeMap((config) => {
      const minifier = options.minifier ?? config?.build?.minifier ?? 'esbuild'
      const minifyLevel = options.minifyLevel ?? config?.build?.minifyLevel ?? 'default'
      const logLevel = options.logLevel ?? config?.build?.logLevel ?? 'debug'
      const pureFuncs = LOG_LEVEL_PURE_FUNCS[logLevel]

      // Compute the on-device path for each entry, mirroring writeFiles'
      // co-locate logic: files outside rootDir land under it.
      const toOutputPath = (src: string): string => {
        const js = src.replace(/\.ts$/, '.js')
        return rootDir === '.' || js.startsWith(rootDir + '/') ? js : pathlib.join(rootDir, js)
      }
      const entryOutputs = entries.map(toOutputPath)

      // Populated by the trace inside writeFiles; read by the features event
      // emitted after it.
      let builtinImports: Map<string, BuiltinImportKind> | undefined
      let nativeImports: Map<string, NativeImport> | undefined

      const writeFiles = writeTraced(
        entries,
        rootDir,
        buildDir,
        {minify: options.minify, minifier, minifyLevel, pureFuncs},
        (traced, natives) => {
          builtinImports = traced
          nativeImports = natives
        },
      )

      const writePackageJson = defer(async () => {
        const pkgPath = pathlib.join(process.cwd(), 'package.json')
        const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
        // Paths in the manifest are relative to rootDir, so the firmware
        // resolves them against /appfs/<rootDir>/ via MIK_LoadTests.
        const relToRoot = (out: string): string =>
          rootDir === '.' || out.startsWith(rootDir + '/') ? pathlib.relative(rootDir, out) : out
        const tests = entryOutputs.map((o) => `./${relToRoot(o)}`)
        return output(
          buildDir,
          pathlib.join(rootDir, 'package.json'),
          JSON.stringify({
            name: pkg.name,
            version: pkg.version,
            type: pkg.type,
            tests,
          }),
        )
      })

      const writeConfig = defer(() => {
        if (config === null) return EMPTY
        return output(
          buildDir,
          pathlib.join(rootDir, 'mikro.config.json'),
          JSON.stringify(serializeRuntimeConfig(config)),
        )
      })

      // Locate static/ by walking up from the first entry (same heuristic
      // as build()). All tests in one project share one static dir.
      const staticDir = (() => {
        let dir = pathlib.dirname(entries[0]!)
        while (dir !== '.' && dir !== '' && dir !== '/') {
          const candidate = pathlib.join(dir, 'static')
          if (existsSync(candidate)) return candidate
          const parent = pathlib.dirname(dir)
          if (parent === dir) break
          dir = parent
        }
        const rootCandidate = 'static'
        if (existsSync(rootCandidate)) return rootCandidate
        return null
      })()
      const staticOutputDir = staticDir ?? pathlib.join(rootDir, 'static')
      let staticFiles: string[] = []
      const writeStatic = defer(async () => {
        if (!staticDir) return
        try {
          const s = await stat(staticDir)
          if (s.isDirectory()) {
            staticFiles = await copyStaticDir(staticDir, buildDir, staticOutputDir)
          }
        } catch {
          // No static directory — nothing to copy
        }
      })

      return concat(
        phase('Tracing imports'),
        defer(() => rm(buildDir, {force: true, recursive: true})).pipe(ignoreElements()),
        writeFiles,
        defer(() =>
          of<BuildEvent>({
            type: 'features',
            ...computeFeatures(builtinImports, nativeImports, config?.features),
          }),
        ),
        writePackageJson.pipe(ignoreElements()),
        writeConfig.pipe(ignoreElements()),
        writeStatic.pipe(ignoreElements()),
        options.bytecode
          ? concat(
              phase('Compiling bytecode'),
              defer(() => {
                const keepPlain = new Set([
                  pathlib.resolve(buildDir, rootDir, 'package.json'),
                  pathlib.resolve(buildDir, rootDir, 'mikro.config.json'),
                  ...staticFiles,
                ])
                return compileJson(buildDir, keepPlain)
              }).pipe(ignoreElements()),
              defer(() => {
                const skip = new Set(staticFiles)
                return compileBytecode(buildDir, skip)
              }).pipe(ignoreElements()),
            )
          : EMPTY,
        defer(() => collectOutputFiles(buildDir)).pipe(mergeMap((events) => from(events))),
        of({type: 'done' as const}),
      )
    }),
  )
}

function extractImports(source: string): string[] {
  const imports = new Set<string>()
  for (const match of source.matchAll(/from\s*["']([^"']+)["']/g)) {
    imports.add(match[1]!)
  }
  for (const match of source.matchAll(/import\s*["']([^"']+)["']/g)) {
    imports.add(match[1]!)
  }
  return [...imports]
}

async function findFilesByExt(dir: string, ext: string): Promise<string[]> {
  const entries = await readdir(dir, {withFileTypes: true})
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = pathlib.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await findFilesByExt(fullPath, ext)))
    } else if (entry.name.endsWith(ext)) {
      files.push(fullPath)
    }
  }
  return files
}

function compileBytecode(buildDir: string, skip?: Set<string>) {
  return defer(() => findFilesByExt(buildDir, '.js')).pipe(
    mergeMap((files) => from(files)),
    filter((file) => !skip?.has(pathlib.resolve(file))),
    mergeMap(async (file) => {
      const {compileBytecode: nativeCompileBytecode} = await loadNative()
      const source = await readFile(file, 'utf-8')
      const imports = extractImports(source)
      const relPath = pathlib.relative(buildDir, file)
      const moduleName = `/${relPath}`
      const moduleDir = pathlib.dirname(moduleName)
      const externals = imports.map((imp) => {
        if (imp.startsWith('.')) {
          return pathlib.join(moduleDir, imp)
        }
        return imp
      })
      const outFile = file.replace(/\.js$/, '.bjs')
      const bytecode = nativeCompileBytecode(source, moduleName, externals)
      await writeFile(outFile, bytecode)
      await unlink(file)
    }, 4),
  )
}

function compileJson(buildDir: string, keepPlain: Set<string>) {
  return defer(() => findFilesByExt(buildDir, '.json')).pipe(
    mergeMap((files) => from(files)),
    filter((file) => !keepPlain.has(pathlib.resolve(file))),
    mergeMap(async (file) => {
      const {jsonToBjson} = await loadNative()
      const json = await readFile(file, 'utf-8')
      const bjson = jsonToBjson(json)
      const outFile = file.replace(/\.json$/, '.bjson')
      await writeFile(outFile, bjson)
      await unlink(file)
    }, 4),
  )
}

async function copyStaticDir(
  srcDir: string,
  buildDir: string,
  outputBase: string,
): Promise<string[]> {
  const copied: string[] = []
  const entries = await readdir(srcDir, {withFileTypes: true})
  for (const entry of entries) {
    const srcPath = pathlib.join(srcDir, entry.name)
    const outRel = pathlib.join(outputBase, entry.name)
    if (entry.isDirectory()) {
      copied.push(...(await copyStaticDir(srcPath, buildDir, outRel)))
    } else {
      const data = await readFile(srcPath)
      await output(buildDir, outRel, data)
      copied.push(pathlib.resolve(buildDir, outRel))
    }
  }
  return copied
}

/** The contents a traced source file deploys with. `rewrites` are offsets into
 *  the source: stripping types keeps every offset, minifying does not, so the
 *  order below matters. */
async function transform(
  source: string,
  contents: Buffer,
  rewrites: Rewrite[],
  options: TransformOptions,
): Promise<string | Buffer> {
  const parsedPath = pathlib.parse(source)
  if (REWRITABLE.includes(parsedPath.ext)) {
    let code = contents.toString()
    if (parsedPath.ext === '.ts') code = stripTypeScriptTypes(code, {mode: 'strip'})
    code = applyRewrites(code, rewrites)
    if (options.minify) {
      code = await minifyJs(code, options.minifier, options.minifyLevel, options.pureFuncs)
    }
    return code
  }
  return contents
}

async function output(outputPath: string, filePath: string, contents: Buffer | string) {
  const dest = pathlib.join(outputPath, filePath)
  const dirname = pathlib.dirname(dest)
  await mkdir(dirname, {recursive: true})
  return writeFile(dest, contents)
}
