import * as pathlib from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import {readFile} from 'fs/promises'
import {lastValueFrom, tap} from 'rxjs'

import type {LogLevel, Minifier, MinifyLevel} from '../../../_exports/index.js'
import {agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {build, type BuildEvent} from '../../lib/build.js'
import {buildConfigDefaults, serializeConfigSchema} from '../../lib/configSchema.js'
import {displayPath} from '../../lib/displayPath.js'
import {describeError} from '../../lib/errorMessage.js'
import {formatSize} from '../../lib/formatSize.js'
import {loadMikroConfig} from '../../lib/loadMikroConfig.js'
import {
  finalizeBuild,
  normalizeRepositoryDirectory,
  normalizeRepositoryUrl,
  type OtaManifest,
  type PackArtifact,
  readBytecodeVersion,
  resolveFirmwareVersion,
  resolveGitState,
  snapshotVersion,
} from '../../lib/ota.js'
import {parseLogLevel, parseMinifier, parseMinifyLevel} from '../../lib/parseMinifier.js'
import {getMikroDir, resolveProjectRoot} from '../../lib/projectRoot.js'
import {resolveEntry} from '../../lib/resolveEntry.js'

export const args = command(
  'pack',
  object({
    subcommand: constant('pack' as const),
    out: optional(
      option('--out', path({metavar: 'FILE', allowCreate: true, type: 'file'}), {
        description: message`Output path for the build (default: ./app-<version>.tgz)`,
      }),
    ),
    snapshot: optional(
      flag('--snapshot', {
        description: message`Derive a unique version from the build time (<version>-snapshot.<ts>) so iteration doesn't need a package.json bump`,
      }),
    ),
    noMinify: optional(flag('--no-minify', {description: message`Skip minification`})),
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
    logLevel: optional(
      option('--loglevel', string({metavar: 'LEVEL'}), {
        description: message`Log level: none, error, warn, info, debug. Console calls below this level are eliminated at build time.`,
      }),
    ),
  }),
  {description: message`Pack the current project into a deployable OTA build`},
)

type Args = InferValue<typeof args>

/** The `package.json` fields a pack reads: the app's identity and its source. */
interface ProjectPackageJson {
  name?: string
  version?: string
  repository?: string | {url?: string; directory?: string}
}

async function readPackageJson(projectRoot: string): Promise<ProjectPackageJson> {
  const raw = await readFile(pathlib.join(projectRoot, 'package.json'), 'utf-8')
  return JSON.parse(raw) as ProjectPackageJson
}

/** The project name identifies the OTA app and is required (no default): the
 * registry scopes updates by app, so a build with no name can't be targeted. */
function projectName(pkg: ProjectPackageJson): string {
  if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
    throw new Error('Cannot publish: package.json has no "name" — it identifies the OTA app.')
  }
  return pkg.name
}

/** The build settings, as one line: what actually shaped the bytecode, so a
 *  surprising checksum or a stripped console call is traceable to a setting. */
function describeBuildSettings(s: Extract<BuildEvent, {type: 'settings'}>): string {
  const parts = [s.minify ? `minify ${s.minifier} ${s.minifyLevel}` : 'no minify']
  parts.push(`loglevel ${s.logLevel}`)
  if (s.bundle) parts.push('bundled')
  return parts.join(', ')
}

/**
 * Build the current project to bytecode and pack it into an OTA `.tgz`.
 * Shared by `mikro ota pack`, `mikro ota push` (when no `--tarball` is given),
 * and `mikro deploy`. Only `mikro ota pack` leaves the result in place: the
 * others pass an `out` under `.mikro/` and treat it as scratch.
 */
export async function packProject(options: {
  out?: string
  entry?: string
  log?: (msg: string) => void
  /** Build-shaping options (default: minified, esbuild, all console kept).
   *  Bytecode is always on: an OTA build must be loadable as `.bjs`. */
  minify?: boolean
  minifier?: Minifier
  minifyLevel?: MinifyLevel
  logLevel?: LogLevel
  /** Derive a unique version from git state instead of `package.json`, so dev
   *  iteration does not collide with the registry's version immutability. */
  snapshot?: boolean
}): Promise<PackArtifact> {
  const log = options.log ?? (() => {})
  const projectRoot = resolveProjectRoot()
  const entry = resolveEntry(options.entry)
  const buildDir = pathlib.join(getMikroDir(), 'ota-build')

  await lastValueFrom(
    build(entry, buildDir, {
      minify: options.minify ?? true,
      bytecode: true,
      minifier: options.minifier,
      minifyLevel: options.minifyLevel,
      // Default to 'warn', exactly as `mikro deploy` does. Without it the shared
      // builder falls back to 'debug', so a published build keeps every console
      // call while the deployed one strips them: two different builds, two
      // different checksums, and a device can never recognise the fleet build as
      // the one it is already running.
      logLevel: options.logLevel ?? 'warn',
      env: 'production',
    }).pipe(
      // Report the settings the build resolved, not the flags passed in: a
      // mikro.config.ts can set the minifier or level, and only the builder
      // knows what won.
      tap((event) => {
        if (event.type === 'settings') log(`Building… (${describeBuildSettings(event)})`)
      }),
    ),
    {defaultValue: undefined},
  )

  const [pkg, firmwareVersion, bytecodeVersion, git, mikroConfig] = await Promise.all([
    readPackageJson(projectRoot),
    resolveFirmwareVersion(projectRoot),
    readBytecodeVersion(buildDir),
    resolveGitState(projectRoot),
    loadMikroConfig(projectRoot, 'production'),
  ])
  const app = projectName(pkg)
  const baseVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  const configSchema = serializeConfigSchema(mikroConfig)

  const version = options.snapshot ? snapshotVersion(baseVersion, new Date()) : baseVersion

  // Where the build came from, baked in at pack so it survives a pack here and a
  // push elsewhere: `push --tarball` reads all of this back from the manifest
  // rather than inspecting whatever project the pushing machine sits in.
  const manifest: OtaManifest = {app, version, firmwareVersion, bytecodeVersion}
  const repository = normalizeRepositoryUrl(pkg.repository)
  if (repository !== undefined) {
    manifest.repository = repository
    // Only alongside a repository: a path with nothing to resolve it against
    // links nowhere.
    const directory = normalizeRepositoryDirectory(pkg.repository)
    if (directory !== undefined) manifest.directory = directory
  }
  if (git.sha !== null) {
    manifest.commit = git.sha
    if (git.dirty) manifest.dirty = true
  }
  if (configSchema !== undefined) {
    manifest.configSchema = configSchema
    // What the device reads instead of the schema: the materialized defaults,
    // partial when required leaves or secrets are declared.
    manifest.configDefaults = buildConfigDefaults(configSchema)
  }

  // Default to the working directory, like `npm pack`: this is the artifact the
  // caller asked for, not tool state, and `.mikro/` is gitignored, so a build
  // packed there is invisible to `ls` and easy to lose. `mikro ota push` passes
  // its own `out` under `.mikro/`, where a scratch file belongs.
  const outPath = options.out ?? pathlib.resolve(`app-${version}.tgz`)
  // --snapshot is the one flag that shapes the pack rather than the build.
  log(options.snapshot ? 'Packing… (snapshot)' : 'Packing…')
  return finalizeBuild(buildDir, outPath, manifest)
}

export async function run(config: Args, jsonFlag = false): Promise<void> {
  const jsonOutput = jsonFlag || isAgentMode()
  // eslint-disable-next-line no-console
  const log = jsonOutput ? () => {} : (msg: string) => console.error(msg)
  try {
    const artifact = await packProject({
      out: config.out,
      log,
      minify: !config.noMinify,
      minifier: parseMinifier(config.minifier),
      minifyLevel: parseMinifyLevel(config.minifyLevel),
      logLevel: parseLogLevel(config.logLevel),
      snapshot: config.snapshot,
    })
    if (jsonOutput) {
      agentResult('ota pack', {
        path: artifact.outPath,
        checksum: artifact.checksum,
        size: artifact.size,
        app: artifact.manifest.app,
        version: artifact.manifest.version,
        firmwareVersion: artifact.manifest.firmwareVersion,
        bytecodeVersion: artifact.manifest.bytecodeVersion,
        // The source the build was packed from, so a pipeline can record it
        // without unpacking the artifact to read the manifest.
        repository: artifact.manifest.repository,
        directory: artifact.manifest.directory,
        commit: artifact.manifest.commit,
        dirty: artifact.manifest.dirty,
      })
    } else {
      // Lead with the verb and what was packed, like every other ota command.
      // The version is spelled out because with --snapshot it is derived, and
      // --out hides it from the default app-<version>.tgz filename.
      // eslint-disable-next-line no-console
      console.log(`Packed ${artifact.manifest.app}@${artifact.manifest.version}`)
      // eslint-disable-next-line no-console
      console.log(`  file      ${displayPath(artifact.outPath)}`)
      // eslint-disable-next-line no-console
      console.log(`  checksum  ${artifact.checksum}`)
      // eslint-disable-next-line no-console
      console.log(`  size      ${formatSize(artifact.size)}`)
    }
  } catch (err) {
    if (jsonOutput) {
      agentError('ota pack', describeError(err))
    } else {
      // The error object, not a string: Node renders the cause chain, which is
      // where the actionable detail lives.
      // eslint-disable-next-line no-console
      console.error('Error:', err)
    }
    process.exit(1)
  }
}
